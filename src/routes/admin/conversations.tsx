import { Hono } from "hono";
import { csrf } from "hono/csrf";
import type { AppEnv } from "../../env";
import { requireAdmin } from "../../lib/admin-auth";
import { attachmentsFor, formatSize, serveAttachment } from "../../lib/attachments";
import { cancelBooking, loadIntent, offerConsult, paymentUrl, retryGoogle, sendSummary, SUMMARY_MAX } from "../../lib/booking";
import { INTAKE_QUESTIONS, readIntake } from "../../lib/intake";
import { conversationUrl, deliverMessage, sendOutgoing } from "../../lib/conversations";
import { getPromo, listPromos, promoBody } from "../../lib/promo";
import { promoMeta } from "./promos";
import { formatEur } from "../../lib/guide";
import { formatSlot } from "../../lib/slots";
import { getHostTz } from "../../lib/settings";
import { formatTr } from "../../lib/time";
import { AdminLayout } from "../../views/layout";

export const STATES = ["new", "ours", "theirs", "awaiting_booking", "completed", "closed"] as const;
export type State = (typeof STATES)[number];

export const STATE_LABEL: Record<State, string> = {
  new: "Yeni",
  ours: "Sıra bizde",
  theirs: "Sıra onlarda",
  awaiting_booking: "Randevu bekliyor",
  completed: "Tamamlandı",
  closed: "Kapandı",
};

const AUTHOR_LABEL: Record<string, string> = { customer: "Müşteri", gizem: "Gizem", baran: "Baran", system: "Sistem" };
const SOURCE_LABEL: Record<string, string> = { danismanlik: "Danışmanlık sayfası", hakkimizda: "Hakkımızda sayfası", rehber: "Rehber satın alımı" };

const isState = (s: string | undefined): s is State => !!s && (STATES as readonly string[]).includes(s);

export const admin = new Hono<AppEnv>();
admin.use("*", requireAdmin);
admin.use("*", csrf()); // rejects cross-origin form POSTs

type ListRow = {
  id: number; subject: string | null; state: State; last_message_at: string | null;
  name: string | null; email: string; preview: string | null; message_count: number;
};

admin.get("/", async (c) => {
  const filter = c.req.query("durum");
  const state = isState(filter) ? filter : null;
  const [tz, list, counts] = await Promise.all([
    getHostTz(c.env.DB),
    c.env.DB.prepare(
      `SELECT c.id, c.subject, c.state, c.last_message_at, ct.name, ct.email,
              (SELECT m.body_text FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS preview,
              (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
         FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
        WHERE ?1 IS NULL OR c.state = ?1
        ORDER BY COALESCE(c.last_message_at, c.created_at) DESC, c.id DESC
        LIMIT 200`,
    ).bind(state).all<ListRow>(),
    c.env.DB.prepare("SELECT state, COUNT(*) AS n FROM conversations GROUP BY state").all<{ state: State; n: number }>(),
  ]);
  const countBy = Object.fromEntries(counts.results.map((r) => [r.state, r.n])) as Partial<Record<State, number>>;
  const total = counts.results.reduce((a, r) => a + r.n, 0);
  const me = c.get("admin");

  return c.html(
    "<!doctype html>" +
      (
        <AdminLayout title="Konuşmalar" current="/admin/" adminName={me.author === "gizem" ? "Gizem" : "Baran"}>
          <header>
            <p class="eyebrow">Yönetim</p>
            <h1>Konuşmalar</h1>
          </header>
          <section>
            <nav class="filters" aria-label="Duruma göre süz">
              <a href="/admin/" aria-current={state === null ? "page" : undefined}>Tümü <span>{total}</span></a>
              {STATES.map((s) => (
                <a href={`/admin/?durum=${s}`} aria-current={state === s ? "page" : undefined}>
                  {STATE_LABEL[s]} <span>{countBy[s] ?? 0}</span>
                </a>
              ))}
            </nav>
            {list.results.length === 0 ? (
              <p class="small">Burada henüz konuşma yok.</p>
            ) : (
              <ul class="conv-list">
                {list.results.map((r) => (
                  <li>
                    <a href={`/admin/konusma/${r.id}`}>
                      <span class="conv-top">
                        <span class="conv-name">{r.name || r.email}</span>
                        <span class={`state state-${r.state}`}>{STATE_LABEL[r.state]}</span>
                      </span>
                      <span class="conv-meta">
                        {r.email} · {r.subject ?? "—"} · {r.message_count} mesaj · {formatTr(r.last_message_at, tz)}
                      </span>
                      {r.preview && <span class="conv-preview">{r.preview}</span>}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </AdminLayout>
      ),
  );
});

type Conv = {
  id: number; subject: string | null; state: State; created_at: string; last_message_at: string | null;
  source: string | null; consent_at: string | null; reply_token: string; name: string | null; email: string; phone: string | null;
  consult_offered_at: string | null;
};
type Msg = {
  id: number; direction: "in" | "out"; body_text: string | null; author: string; created_at: string;
  via: string | null; send_status: string | null; send_error: string | null; from_addr: string | null;
};

const VIA_LABEL: Record<string, string> = { form: "form", email: "e-posta", web: "web", admin: "e-posta", system: "e-posta" };
const REPLY_MAX = 10000;

admin.get("/konusma/:id{[0-9]+}", async (c) => {
  const id = Number(c.req.param("id"));
  const [tz, conv, msgs] = await Promise.all([
    getHostTz(c.env.DB),
    c.env.DB.prepare(
      `SELECT c.id, c.subject, c.state, c.created_at, c.last_message_at, c.source, c.consent_at, c.reply_token, c.consult_offered_at, ct.name, ct.email, ct.phone
         FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE c.id = ?1`,
    ).bind(id).first<Conv>(),
    c.env.DB.prepare(
      `SELECT id, direction, body_text, author, created_at, via, send_status, send_error, from_addr
         FROM messages WHERE conversation_id = ?1 ORDER BY created_at, id`,
    ).bind(id).all<Msg>(),
  ]);
  const [atts, consult, promos] = await Promise.all([
    attachmentsFor(c.env.DB, id),
    consultFor(c.env.DB, id),
    listPromos(c.env).catch((e) => (console.error("listing promotion codes failed", e), null)),
  ]);
  if (!conv) return c.text("Konuşma bulunamadı.", 404);
  const me = c.get("admin");
  const saved = c.req.query("kaydedildi") === "1";
  const replied = c.req.query("gonderildi");
  const customerUrl = conv ? conversationUrl(c.env, conv.reply_token) : "";

  return c.html(
    "<!doctype html>" +
      (
        <AdminLayout title={conv.name || conv.email} current="/admin/" adminName={me.author === "gizem" ? "Gizem" : "Baran"}>
          <header>
            <p class="eyebrow"><a href="/admin/">← Konuşmalar</a></p>
            <h1 class="admin-h1">{conv.name || conv.email}</h1>
            <p class="lede">{conv.subject ?? "—"}</p>
          </header>

          <section>
            <dl class="facts">
              <dt>E-posta</dt><dd>{conv.email}</dd>
              <dt>Telefon</dt><dd>{conv.phone ?? "—"}</dd>
              <dt>Kaynak</dt><dd>{conv.source ? (SOURCE_LABEL[conv.source] ?? conv.source) : "—"}</dd>
              <dt>Başlangıç</dt><dd>{formatTr(conv.created_at, tz)}</dd>
              <dt>Onay</dt><dd>{conv.consent_at ? formatTr(conv.consent_at, tz) : "—"}</dd>
              <dt>Müşteri sayfası</dt><dd><a href={customerUrl} rel="noreferrer">{customerUrl}</a></dd>
            </dl>
            <form class="state-form" method="post" action={`/admin/konusma/${conv.id}/durum`}>
              <label for="durum">Durum</label>
              <select id="durum" name="durum">
                {STATES.map((s) => (
                  <option value={s} selected={s === conv.state}>{STATE_LABEL[s]}</option>
                ))}
              </select>
              <button class="btn btn-small" type="submit">Kaydet</button>
              {saved && <span class="saved" role="status">Kaydedildi</span>}
            </form>
          </section>

          {conv.source !== "rehber" && (
            <ConsultSection env={c.env} conv={conv} consult={consult} tz={tz} signer={me.author === "gizem" ? "Gizem" : "Baran"} flash={c.req.query("odeme")} />
          )}

          <section>
            <h2>Mesajlar</h2>
            <ol class="thread">
              {msgs.results.map((m) => (
                <li class={`msg msg-${m.direction}`}>
                  <p class="msg-head">
                    <span>{AUTHOR_LABEL[m.author] ?? m.author}</span>
                    <span class="msg-meta">
                      {m.direction === "out" ? "e-posta · " : m.via ? `${VIA_LABEL[m.via] ?? m.via} · ` : ""}
                      <time datetime={m.created_at}>{formatTr(m.created_at, tz)}</time>
                    </span>
                  </p>
                  {m.from_addr && m.from_addr !== conv.email.toLowerCase() && (
                    <p class="msg-warn">Farklı bir adresten geldi: {m.from_addr}</p>
                  )}
                  <p class="msg-body">{m.body_text ?? ""}</p>
                  {atts.get(m.id)?.length ? (
                    <ul class="attachments">
                      {atts.get(m.id)!.map((a) => (
                        <li><a href={`/admin/ek/${a.id}`}>{a.filename}</a> <span>{formatSize(a.size)}</span></li>
                      ))}
                    </ul>
                  ) : null}
                  {m.send_status === "failed" && (
                    <form class="msg-retry" method="post" action={`/admin/mesaj/${m.id}/tekrar`}>
                      <span class="msg-warn">Gönderilemedi{m.send_error ? `: ${m.send_error}` : ""}</span>
                      <button class="btn-ghost btn-small" type="submit">Tekrar gönder</button>
                    </form>
                  )}
                  {m.send_status === "pending" && <p class="msg-warn">Gönderiliyor…</p>}
                </li>
              ))}
            </ol>
          </section>

          <section id="yanit">
            <h2>Yanıt yaz</h2>
            {replied === "1" && <p class="note" role="status">Gönderildi.</p>}
            {replied === "0" && <p class="form-error" role="alert">Mesaj kaydedildi ama gönderilemedi. Yukarıdan tekrar gönderebilirsin.</p>}
            <form class="form-stack" method="post" action={`/admin/konusma/${conv.id}/yanit`}>
              <label for="metin">Mesaj <span class="opt">({conv.email} adresine, imza: {me.author === "gizem" ? "Gizem" : "Baran"})</span></label>
              <textarea id="metin" name="metin" rows={8} required maxlength={REPLY_MAX}></textarea>
              <button class="btn" type="submit">Gönder</button>
            </form>
          </section>

          <section id="kod">
            <h2>İndirim kodu gönder</h2>
            {c.req.query("kod") === "1" && <p class="note" role="status">Kod gönderildi.</p>}
            {c.req.query("kod") === "0" && <p class="form-error" role="alert">Mesaj kaydedildi ama gönderilemedi. Yukarıdan tekrar gönderebilirsin.</p>}
            {promos === null ? (
              <p class="form-error" role="alert">Kodlar Stripe'tan alınamadı.</p>
            ) : promos.length === 0 ? (
              <p class="small">Aktif kod yok. <a href="/admin/kodlar">Kod oluştur →</a></p>
            ) : (
              <form class="form-stack" method="post" action={`/admin/konusma/${conv.id}/kod`}>
                <label for="kod-sec">Kod <span class="opt">(hazır bir e-postayla {conv.email} adresine gider, imza: {me.author === "gizem" ? "Gizem" : "Baran"})</span></label>
                <select id="kod-sec" name="kod">
                  {promos.map((p) => (
                    <option value={p.id}>{p.code} — {promoMeta(p, tz)}</option>
                  ))}
                </select>
                <button class="btn-ghost" type="submit">Kodu gönder</button>
              </form>
            )}
          </section>
        </AdminLayout>
      ),
  );
});

type ConsultRow = {
  intent_id: number; token: string; created_at: string; amount_cents: number | null; currency: string | null; invoice_url: string | null;
  expires_at: string; booking_id: number | null; start_utc: string | null; customer_tz: string | null; state: string | null;
  reschedule_count: number | null; refund_status: string | null; cancelled_by: string | null;
  meet_url: string | null; gcal_status: string | null; gcal_error: string | null;
  intake_json: string | null; intake_submitted_at: string | null; summary_sent_at: string | null; reminder_sent_at: string | null;
};

async function consultFor(db: D1Database, convId: number) {
  return (await db.prepare(
    `SELECT i.id AS intent_id, i.token, i.created_at, i.amount_cents, i.currency, i.invoice_url, i.expires_at,
            b.id AS booking_id, b.start_utc, b.customer_tz, b.state, b.reschedule_count, b.refund_status, b.cancelled_by,
            b.meet_url, b.gcal_status, b.gcal_error, b.intake_json, b.intake_submitted_at, b.summary_sent_at, b.reminder_sent_at
       FROM booking_intents i LEFT JOIN bookings b ON b.booking_intent_id = i.id
      WHERE i.conversation_id = ?1 ORDER BY i.id`,
  ).bind(convId).all<ConsultRow>()).results;
}

const BOOKING_STATE: Record<string, string> = {
  confirmed: "Onaylandı", rescheduled: "Saati değişti", cancelled: "İptal edildi", completed: "Tamamlandı", no_show: "Gelmedi",
};
const REFUND: Record<string, string> = { refunded: "iade edildi", not_eligible: "iade yok", failed: "İADE BAŞARISIZ — Stripe'tan elle yap" };

function GoogleFacts({ r }: { r: ConsultRow }) {
  const live = r.state === "confirmed" || r.state === "rescheduled";
  const retry = (label: string) => (
    <form class="msg-retry" method="post" action={`/admin/randevu/${r.booking_id}/google`}>
      {r.gcal_status === "failed" && <span class="msg-warn">Google'a yazılamadı{r.gcal_error ? `: ${r.gcal_error}` : ""}</span>}
      <button class="btn-ghost btn-small" type="submit">{label}</button>
    </form>
  );
  return (
    <>
      <dt>Meet</dt>
      <dd>
        {r.meet_url ? <a href={r.meet_url} rel="noreferrer">{r.meet_url}</a> : "—"}
        {live && r.gcal_status !== "synced" && retry(r.gcal_status === "failed" ? "Tekrar dene" : "Google'a yaz")}
        {!live && r.gcal_status === "failed" && retry("Google'dan silmeyi tekrar dene")}
      </dd>
    </>
  );
}

function IntakeFacts({ r, tz }: { r: ConsultRow; tz: string }) {
  const a = readIntake(r.intake_json);
  return (
    <>
      <dt>Ön form</dt>
      <dd>
        {a ? (
          <details>
            <summary>Dolduruldu · {formatTr(r.intake_submitted_at, tz)}</summary>
            <dl class="facts">
              {INTAKE_QUESTIONS.map((q) => <><dt>{q.label}</dt><dd class="msg-body">{a[q.key] || "—"}</dd></>)}
            </dl>
          </details>
        ) : "Doldurulmadı"}
      </dd>
      <dt>Hatırlatma</dt>
      <dd>{r.reminder_sent_at ? `Gönderildi · ${formatTr(r.reminder_sent_at, tz)}` : "Görüşmeden ~24 saat önce gidecek"}</dd>
    </>
  );
}

function SummaryForm({ r, tz, signer }: { r: ConsultRow; tz: string; signer: string }) {
  if (r.summary_sent_at) return <p class="small">Yazılı özet gönderildi · {formatTr(r.summary_sent_at, tz)}. Ek notlar için aşağıdan normal yanıt yaz.</p>;
  if (Date.parse(r.start_utc!) > Date.now()) return <p class="small">Yazılı özet görüşmeden sonra buradan gönderilecek.</p>;
  return (
    <form class="form-stack" id="ozet" method="post" action={`/admin/randevu/${r.booking_id}/ozet`}>
      <label for={`ozet-${r.booking_id}`}>Yazılı özet <span class="opt">(konuşmaya eklenir ve e-postayla gider, imza: {signer}; randevu “Tamamlandı” olur)</span></label>
      <textarea id={`ozet-${r.booking_id}`} name="metin" rows={14} required maxlength={SUMMARY_MAX}></textarea>
      <button class="btn" type="submit">Özeti gönder</button>
    </form>
  );
}

function ConsultSection({ env, conv, consult, tz, signer, flash }: { env: Env; conv: Conv; consult: ConsultRow[]; tz: string; signer: string; flash?: string }) {
  const payUrl = paymentUrl(env, conv.reply_token);
  return (
    <section id="danismanlik">
      <h2>Durum Analizi</h2>
      {flash === "1" && <p class="note" role="status">Ödeme bağlantısı gönderildi.</p>}
      {flash === "0" && <p class="form-error" role="alert">Mesaj kaydedildi ama gönderilemedi. Aşağıdan tekrar gönderebilirsin.</p>}
      {flash === "iptal" && <p class="note" role="status">Randevu iptal edildi.</p>}
      {flash === "google" && <p class="note" role="status">Google Takvim güncellendi.</p>}
      {flash === "googlehata" && <p class="form-error" role="alert">Google Takvim'e yine yazılamadı. Takvim sayfasında bağlantıyı kontrol et.</p>}
      {flash === "ozet1" && <p class="note" role="status">Özet gönderildi.</p>}
      {flash === "ozet0" && <p class="form-error" role="alert">Özet kaydedildi ama gönderilemedi. Mesajlardan tekrar gönderebilirsin.</p>}
      {consult.map((r) => (
        <dl class="facts">
          <dt>Ödeme</dt>
          <dd>
            {formatEur(r.amount_cents ?? 0, r.currency ?? "eur")} · {formatTr(r.created_at, tz)}
            {r.invoice_url ? <> · <a href={r.invoice_url} rel="noreferrer">fatura</a></> : null}
          </dd>
          <dt>Randevu</dt>
          <dd>
            {r.booking_id && r.start_utc ? (
              <>
                {formatSlot(r.start_utc, tz)} ({tz}) · {BOOKING_STATE[r.state ?? ""] ?? r.state}
                {r.reschedule_count ? ` · ${r.reschedule_count} kez değişti` : ""}
                {r.refund_status ? ` · ${REFUND[r.refund_status] ?? r.refund_status}` : ""}
                {r.customer_tz && r.customer_tz !== tz ? <><br />Müşteri için: {formatSlot(r.start_utc, r.customer_tz)} ({r.customer_tz})</> : null}
              </>
            ) : (
              `Henüz saat seçilmedi (bağlantı ${formatTr(r.expires_at, tz)} tarihine kadar geçerli)`
            )}
          </dd>
          {r.booking_id && <GoogleFacts r={r} />}
          {r.booking_id && r.state !== "cancelled" && <IntakeFacts r={r} tz={tz} />}
          <dt>Müşteri sayfası</dt>
          <dd><a href={`${env.APP_URL}/randevu/${r.token}`} rel="noreferrer">{`${env.APP_URL}/randevu/${r.token}`}</a></dd>
          {r.booking_id && (r.state === "confirmed" || r.state === "rescheduled") && (
            <>
              <dt>İptal</dt>
              <dd>
                <form class="msg-retry" method="post" action={`/admin/randevu/${r.booking_id}/iptal`}>
                  <label class="check-inline"><input type="checkbox" name="onay" required /> Eminim</label>
                  <button class="btn-ghost btn-small" type="submit">İptal et ve tam iade yap</button>
                </form>
              </dd>
            </>
          )}
        </dl>
      ))}
      {consult.filter((r) => r.booking_id && r.state !== "cancelled" && r.start_utc).map((r) => (
        <SummaryForm r={r} tz={tz} signer={signer} />
      ))}
      {consult.length === 0 && (
        <>
          <p class="small">
            {conv.consult_offered_at
              ? `Ödeme bağlantısı ${formatTr(conv.consult_offered_at, tz)} tarihinde gönderildi; henüz ödeme yok. Bağlantı: ${payUrl}`
              : `Durum uygunsa müşteriye ödeme ve randevu bağlantısı içeren standart bir e-posta gönder (imza: ${signer}).`}
          </p>
          <form method="post" action={`/admin/konusma/${conv.id}/odeme`}>
            <button class={conv.consult_offered_at ? "btn-ghost btn-small" : "btn btn-small"} type="submit">
              {conv.consult_offered_at ? "Bağlantıyı tekrar gönder" : "Ödeme bağlantısını gönder"}
            </button>
          </form>
        </>
      )}
    </section>
  );
}

admin.post("/konusma/:id{[0-9]+}/odeme", async (c) => {
  const id = Number(c.req.param("id"));
  const r = await offerConsult(c.env, id, c.get("admin").author);
  if (!r) return c.text("Konuşma bulunamadı.", 404);
  return c.redirect(`/admin/konusma/${id}?odeme=${r.sent ? 1 : 0}#danismanlik`, 303);
});

admin.post("/randevu/:id{[0-9]+}/iptal", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.parseBody();
  if (!body.onay) return c.text("Onay kutusunu işaretle.", 400);
  const row = await c.env.DB.prepare("SELECT i.token FROM bookings b JOIN booking_intents i ON i.id = b.booking_intent_id WHERE b.id = ?1")
    .bind(id).first<{ token: string }>();
  if (!row) return c.text("Randevu bulunamadı.", 404);
  const found = (await loadIntent(c.env.DB, row.token))!;
  if (!found.booking || found.booking.id !== id) return c.text("Randevu bulunamadı.", 404);
  const r = await cancelBooking(c.env, found.intent, found.booking, "admin", c.get("admin").author);
  if (!r.ok) return c.text("Bu randevu iptal edilemiyor (geçmişte ya da zaten iptal).", 409);
  return c.redirect(`/admin/konusma/${found.intent.conversation_id}?odeme=iptal#danismanlik`, 303);
});

admin.post("/randevu/:id{[0-9]+}/ozet", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.parseBody();
  const text = (typeof body.metin === "string" ? body.metin : "").replace(/\r\n/g, "\n").trim();
  if (!text) return c.text("Özet boş.", 400);
  if (text.length > SUMMARY_MAX) return c.text("Özet çok uzun.", 400);
  const r = await sendSummary(c.env, id, c.get("admin").author, text);
  if (!r.ok) {
    const msg = { not_found: "Randevu bulunamadı.", too_early: "Görüşme henüz yapılmadı.", already: "Bu görüşmenin özeti zaten gönderildi." }[r.reason];
    return c.text(msg, r.reason === "not_found" ? 404 : 409);
  }
  return c.redirect(`/admin/konusma/${r.conversationId}?odeme=ozet${r.sent ? 1 : 0}#danismanlik`, 303);
});

admin.post("/randevu/:id{[0-9]+}/google", async (c) => {
  const id = Number(c.req.param("id"));
  const conv = await c.env.DB.prepare("SELECT conversation_id FROM bookings WHERE id = ?1").bind(id).first<{ conversation_id: number }>();
  if (!conv) return c.text("Randevu bulunamadı.", 404);
  const g = await retryGoogle(c.env, id);
  const flash = g?.status === "synced" ? "google" : "googlehata";
  return c.redirect(`/admin/konusma/${conv.conversation_id}?odeme=${flash}#danismanlik`, 303);
});

admin.post("/konusma/:id{[0-9]+}/durum", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.parseBody();
  const next = typeof body.durum === "string" ? body.durum : undefined;
  if (!isState(next)) return c.text("Geçersiz durum.", 400);
  const res = await c.env.DB.prepare("UPDATE conversations SET state = ?1 WHERE id = ?2").bind(next, id).run();
  if (!res.meta.changes) return c.text("Konuşma bulunamadı.", 404);
  return c.redirect(`/admin/konusma/${id}?kaydedildi=1`, 303);
});

admin.post("/konusma/:id{[0-9]+}/yanit", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.parseBody();
  const text = (typeof body.metin === "string" ? body.metin : "").replace(/\r\n/g, "\n").trim();
  if (!text) return c.text("Mesaj boş.", 400);
  if (text.length > REPLY_MAX) return c.text("Mesaj çok uzun.", 400);
  const exists = await c.env.DB.prepare("SELECT 1 FROM conversations WHERE id = ?1").bind(id).first();
  if (!exists) return c.text("Konuşma bulunamadı.", 404);
  const { sent } = await sendOutgoing(c.env, id, c.get("admin").author, text, { via: "admin", nextState: "theirs" });
  return c.redirect(`/admin/konusma/${id}?gonderildi=${sent ? 1 : 0}#yanit`, 303);
});

admin.post("/konusma/:id{[0-9]+}/kod", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.parseBody();
  const promoId = typeof body.kod === "string" ? body.kod : "";
  if (!/^promo_[A-Za-z0-9]+$/.test(promoId)) return c.text("Geçersiz kod.", 400);
  const conv = await c.env.DB.prepare(
    "SELECT c.reply_token, ct.name FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE c.id = ?1",
  ).bind(id).first<{ reply_token: string; name: string | null }>();
  if (!conv) return c.text("Konuşma bulunamadı.", 404);
  const promo = await getPromo(c.env, promoId);
  if (!promo?.active) return c.text("Bu kod artık aktif değil.", 409);
  const tz = await getHostTz(c.env.DB);
  const text = promoBody({
    name: conv.name,
    promo,
    guideUrl: `${c.env.APP_URL}/rehber`,
    paymentUrl: paymentUrl(c.env, conv.reply_token),
    expires: promo.expiresAt ? formatTr(promo.expiresAt, tz).replace(/ \d\d:\d\d$/, "") : null,
  });
  const { sent } = await sendOutgoing(c.env, id, c.get("admin").author, text, { via: "admin", nextState: "theirs" });
  return c.redirect(`/admin/konusma/${id}?kod=${sent ? 1 : 0}#kod`, 303);
});

admin.post("/mesaj/:id{[0-9]+}/tekrar", async (c) => {
  const id = Number(c.req.param("id"));
  const row = await c.env.DB.prepare("SELECT conversation_id FROM messages WHERE id = ?1 AND direction = 'out' AND send_status = 'failed'")
    .bind(id).first<{ conversation_id: number }>();
  if (!row) return c.text("Mesaj bulunamadı.", 404);
  const sent = await deliverMessage(c.env, id);
  return c.redirect(`/admin/konusma/${row.conversation_id}?gonderildi=${sent ? 1 : 0}#yanit`, 303);
});

admin.get("/ek/:id{[0-9]+}", async (c) => {
  const row = await c.env.DB.prepare("SELECT r2_key, filename, content_type FROM attachments WHERE id = ?1")
    .bind(Number(c.req.param("id"))).first<{ r2_key: string; filename: string; content_type: string }>();
  if (!row) return c.text("Dosya bulunamadı.", 404);
  return serveAttachment(c.env, row);
});

type Unmatched = { id: number; from_addr: string | null; to_addr: string | null; subject: string | null; body_text: string | null; created_at: string };

admin.get("/eslesmeyen", async (c) => {
  const [tz, rows] = await Promise.all([
    getHostTz(c.env.DB),
    c.env.DB.prepare("SELECT id, from_addr, to_addr, subject, body_text, created_at FROM unmatched_emails ORDER BY id DESC LIMIT 200").all<Unmatched>(),
  ]);
  const me = c.get("admin");
  return c.html(
    "<!doctype html>" +
      (
        <AdminLayout title="Eşleşmeyen e-postalar" current="/admin/eslesmeyen" adminName={me.author === "gizem" ? "Gizem" : "Baran"}>
          <header>
            <p class="eyebrow">Yönetim</p>
            <h1>Eşleşmeyen e-postalar</h1>
            <p class="lede">Hiçbir konuşmaya bağlanamayan gelen e-postalar. Gerekirse göndereni kendi adresinden yanıtla.</p>
          </header>
          <section>
            {rows.results.length === 0 ? (
              <p class="small">Eşleşmeyen e-posta yok.</p>
            ) : (
              <ol class="thread">
                {rows.results.map((r) => (
                  <li class="msg msg-in">
                    <p class="msg-head">
                      <span>{r.from_addr ?? "—"}</span>
                      <time datetime={r.created_at}>{formatTr(r.created_at, tz)}</time>
                    </p>
                    <p class="msg-warn">Kime: {r.to_addr ?? "—"} · Konu: {r.subject ?? "—"}</p>
                    <p class="msg-body">{r.body_text ?? ""}</p>
                    <form class="msg-retry" method="post" action={`/admin/eslesmeyen/${r.id}/sil`}>
                      <button class="btn-ghost btn-small" type="submit">Sil</button>
                    </form>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </AdminLayout>
      ),
  );
});

admin.post("/eslesmeyen/:id{[0-9]+}/sil", async (c) => {
  await c.env.DB.prepare("DELETE FROM unmatched_emails WHERE id = ?1").bind(Number(c.req.param("id"))).run();
  return c.redirect("/admin/eslesmeyen", 303);
});
