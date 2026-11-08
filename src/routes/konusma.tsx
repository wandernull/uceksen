import { Hono } from "hono";
import { csrf } from "hono/csrf";
import type { AppEnv } from "../env";
import { ATTACH, attachmentsFor, extensionAllowed, formatSize, serveAttachment, storeAttachment, type AttachmentRow } from "../lib/attachments";
import { AUTHOR_NAME, notifyNewMessage, recordIncoming } from "../lib/conversations";
import { allow, clientIp } from "../lib/rate-limit";
import { getHostTz } from "../lib/settings";
import { formatTr, nowIso } from "../lib/time";
import { MessagePage, SiteLayout } from "../views/layout";

export const konusma = new Hono<AppEnv>();
konusma.use("*", csrf());
konusma.use("*", async (c, next) => {
  await next();
  // The URL is the credential: never cache, index, or leak it via Referer.
  c.header("Cache-Control", "private, no-store");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Robots-Tag", "noindex, nofollow");
});

export const REPLY_LIMITS = { body: 5000, rate: 10, windowSec: 3600 } as const;

const MSG = {
  empty: "Bir mesaj yaz ya da dosya ekle.",
  long: `Mesaj çok uzun; en fazla ${REPLY_LIMITS.body} karakter yazabilirsin.`,
  files: `En fazla ${ATTACH.maxFiles} dosya ekleyebilirsin.`,
  big: (n: string) => `“${n}” 10 MB'tan büyük.`,
  type: (n: string) => `“${n}” bu türde bir dosya olduğu için eklenemedi. PDF, görsel, Word ya da Excel dosyası ekle.`,
  rate: "Kısa sürede çok fazla mesaj gönderildi. Bir saat sonra tekrar dene.",
  sent: "Mesajın bize ulaştı. Yanıtımız e-postana gelecek.",
} as const;

const TOKEN = "{[A-Za-z0-9_-]{32}}";

type Conv = { id: number; subject: string | null; name: string | null };
type Msg = { id: number; direction: "in" | "out"; body_text: string | null; author: string; created_at: string; send_status: string | null };

async function load(db: D1Database, token: string) {
  return db.prepare(
    "SELECT c.id, c.subject, ct.name FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE c.reply_token = ?1",
  ).bind(token).first<Conv>();
}

function notFound() {
  return (
    "<!doctype html>" +
    (
      <MessagePage
        title="Bulunamadı"
        eyebrow="Konuşma"
        heading="Bu bağlantı geçersiz"
        text="Bağlantı e-postadan kopyalanırken eksik kalmış olabilir. Sorun sürerse merhaba@uceksen.com adresine yaz."
        back={["/", "← Ana sayfa"]}
      />
    )
  );
}

function who(m: Msg): string {
  if (m.author === "customer") return "Sen";
  if (m.author === "system") return "Üç Eksen";
  return `${AUTHOR_NAME[m.author as "gizem" | "baran"] ?? "Üç Eksen"} · Üç Eksen`;
}

async function page(
  env: Env,
  token: string,
  conv: Conv,
  state: { error?: string; sent?: boolean; draft?: string } = {},
) {
  const [tz, msgs, atts] = await Promise.all([
    getHostTz(env.DB),
    env.DB.prepare(
      `SELECT id, direction, body_text, author, created_at, send_status FROM messages
        WHERE conversation_id = ?1 AND NOT (direction = 'out' AND send_status = 'failed')
        ORDER BY created_at, id`,
    ).bind(conv.id).all<Msg>(),
    attachmentsFor(env.DB, conv.id),
  ]);
  const base = `/konusma/${token}`;
  const fileList = (list: AttachmentRow[] | undefined) =>
    list?.length ? (
      <ul class="attachments">
        {list.map((a) => (
          <li><a href={`${base}/ek/${a.id}`}>{a.filename}</a> <span>{formatSize(a.size)}</span></li>
        ))}
      </ul>
    ) : null;

  return (
    "<!doctype html>" +
    (
      <SiteLayout title={`${conv.subject ?? "Konuşma"} — Üç Eksen`} noindex>
        <header>
          <p class="eyebrow">Konuşma</p>
          <h1>{conv.subject ?? "Konuşma"}</h1>
          <p class="lede">Bu sayfa yalnızca sana ait. Bağlantıyı başkasıyla paylaşma.</p>
        </header>

        <section>
          <h2>Mesajlar</h2>
          <ol class="thread">
            {msgs.results.map((m) => (
              <li class={`msg msg-${m.direction}`}>
                <p class="msg-head">
                  <span>{who(m)}</span>
                  <time datetime={m.created_at}>{formatTr(m.created_at, tz)}</time>
                </p>
                <p class="msg-body">{m.body_text ?? ""}</p>
                {fileList(atts.get(m.id))}
              </li>
            ))}
          </ol>
        </section>

        <section id="yanit">
          <h2>Yanıt yaz</h2>
          {state.sent && <p class="note" role="status">{MSG.sent}</p>}
          <form class="form-stack" method="post" action={base} enctype="multipart/form-data">
            {state.error && <p class="form-error" role="alert">{state.error}</p>}
            <label for="k-metin">Mesajın</label>
            <textarea id="k-metin" name="metin" rows={6} maxlength={REPLY_LIMITS.body}>{state.draft ?? ""}</textarea>
            <label for="k-dosya">
              Dosya ekle <span class="opt">(isteğe bağlı — en fazla {ATTACH.maxFiles} dosya, her biri en fazla 10 MB)</span>
            </label>
            <input id="k-dosya" name="dosya" type="file" multiple accept={ATTACH.extensions.map((e) => `.${e}`).join(",")} />
            <div class="hp" aria-hidden="true">
              <label for="k-website">Web sitesi</label>
              <input id="k-website" name="website" type="text" tabindex={-1} autocomplete="off" />
            </div>
            <button class="btn" type="submit">Gönder</button>
          </form>
        </section>
      </SiteLayout>
    )
  );
}

konusma.get(`/:token${TOKEN}`, async (c) => {
  const token = c.req.param("token");
  const conv = await load(c.env.DB, token);
  if (!conv) return c.html(notFound(), 404);
  return c.html(await page(c.env, token, conv, { sent: c.req.query("gonderildi") === "1" }));
});

konusma.post(`/:token${TOKEN}`, async (c) => {
  const token = c.req.param("token");
  const conv = await load(c.env.DB, token);
  if (!conv) return c.html(notFound(), 404);
  const done = () => c.redirect(`/konusma/${token}?gonderildi=1#yanit`, 303);

  const form = await c.req.formData();
  if (String(form.get("website") ?? "").trim()) return done(); // honeypot

  const text = String(form.get("metin") ?? "").replace(/\r\n/g, "\n").trim();
  const files = form.getAll("dosya").filter((f): f is File => typeof f !== "string" && f.size > 0);
  const fail = async (error: string, status: 400 | 429 = 400) =>
    c.html(await page(c.env, token, conv, { error, draft: text }), status);

  if (!(await allow(c.env.KV, `yanit:${clientIp(c.req.raw)}`, REPLY_LIMITS.rate, REPLY_LIMITS.windowSec))) {
    return fail(MSG.rate, 429);
  }
  if (!text && !files.length) return fail(MSG.empty);
  if (text.length > REPLY_LIMITS.body) return fail(MSG.long);
  if (files.length > ATTACH.maxFiles) return fail(MSG.files);
  for (const f of files) {
    if (f.size > ATTACH.maxBytes) return fail(MSG.big(f.name));
    if (!extensionAllowed(f.name)) return fail(MSG.type(f.name));
  }

  const messageId = await recordIncoming(c.env, { convId: conv.id, text, via: "web" });
  for (const f of files) {
    await storeAttachment(c.env, { convId: conv.id, messageId, filename: f.name, contentType: f.type, body: await f.arrayBuffer(), size: f.size });
  }
  const note = files.length ? `${text}\n\n[${files.length} dosya eklendi: ${files.map((f) => f.name).join(", ")}]`.trim() : text;
  await notifyNewMessage(c.env, conv.id, "Yeni yanıt (web)", note);
  return done();
});

konusma.get(`/:token${TOKEN}/ek/:id{[0-9]+}`, async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT a.r2_key, a.filename, a.content_type FROM attachments a
       JOIN messages m ON m.id = a.message_id JOIN conversations cv ON cv.id = m.conversation_id
      WHERE a.id = ?1 AND cv.reply_token = ?2`,
  ).bind(Number(c.req.param("id")), c.req.param("token")).first<{ r2_key: string; filename: string; content_type: string }>();
  if (!row) return c.html(notFound(), 404);
  return serveAttachment(c.env, row);
});

// Guide update emails link here ("Rehber güncellemeleriyle ilgili e-posta almak istemiyorsan").
// GET only shows the button: mail scanners open links, they must not unsubscribe anyone.
async function contactFor(db: D1Database, token: string) {
  return db.prepare(
    `SELECT ct.id, ct.guide_updates_optout_at FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE c.reply_token = ?1`,
  ).bind(token).first<{ id: number; guide_updates_optout_at: string | null }>();
}

function OptOutPage({ token, out }: { token: string; out: boolean }) {
  return (
    <SiteLayout title="Rehber güncellemeleri — Üç Eksen" noindex>
      <header>
        <p class="eyebrow">Rehber</p>
        <h1>Rehber güncellemeleri</h1>
        <p class="lede">
          {out
            ? "Rehberin yeni sürümleri için artık e-posta göndermiyoruz. Satın alma ve konuşmalarla ilgili e-postalar gelmeye devam eder."
            : "Rehberin yeni sürümü çıktığında yeni indirme bağlantısını e-postayla gönderiyoruz."}
        </p>
      </header>
      <form method="post" action={`/konusma/${token}/abonelik`}>
        <input type="hidden" name="islem" value={out ? "ac" : "kapat"} />
        <button class={out ? "btn-ghost" : "btn"} type="submit">
          {out ? "Güncelleme e-postalarını yeniden al" : "Güncelleme e-postalarını alma"}
        </button>
      </form>
    </SiteLayout>
  );
}

konusma.get(`/:token${TOKEN}/abonelik`, async (c) => {
  const token = c.req.param("token");
  const ct = await contactFor(c.env.DB, token);
  if (!ct) return c.html(notFound(), 404);
  return c.html("<!doctype html>" + <OptOutPage token={token} out={!!ct.guide_updates_optout_at} />);
});

konusma.post(`/:token${TOKEN}/abonelik`, async (c) => {
  const token = c.req.param("token");
  const ct = await contactFor(c.env.DB, token);
  if (!ct) return c.html(notFound(), 404);
  const optOut = (await c.req.parseBody()).islem !== "ac";
  await c.env.DB.prepare("UPDATE contacts SET guide_updates_optout_at = ?1 WHERE id = ?2")
    .bind(optOut ? nowIso() : null, ct.id).run();
  return c.redirect(`/konusma/${token}/abonelik`, 303);
});
