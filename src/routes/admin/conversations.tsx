import { Hono } from "hono";
import { csrf } from "hono/csrf";
import type { AppEnv } from "../../env";
import { requireAdmin } from "../../lib/admin-auth";
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
const SOURCE_LABEL: Record<string, string> = { danismanlik: "Danışmanlık sayfası", hakkimizda: "Hakkımızda sayfası" };

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
        <AdminLayout title="Konuşmalar" current="/admin" adminName={me.author === "gizem" ? "Gizem" : "Baran"}>
          <header>
            <p class="eyebrow">Yönetim</p>
            <h1>Konuşmalar</h1>
          </header>
          <section>
            <nav class="filters" aria-label="Duruma göre süz">
              <a href="/admin" aria-current={state === null ? "page" : undefined}>Tümü <span>{total}</span></a>
              {STATES.map((s) => (
                <a href={`/admin?durum=${s}`} aria-current={state === s ? "page" : undefined}>
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
  source: string | null; consent_at: string | null; name: string | null; email: string; phone: string | null;
};
type Msg = { id: number; direction: "in" | "out"; body_text: string | null; author: string; created_at: string };

admin.get("/konusma/:id{[0-9]+}", async (c) => {
  const id = Number(c.req.param("id"));
  const [tz, conv, msgs] = await Promise.all([
    getHostTz(c.env.DB),
    c.env.DB.prepare(
      `SELECT c.id, c.subject, c.state, c.created_at, c.last_message_at, c.source, c.consent_at, ct.name, ct.email, ct.phone
         FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE c.id = ?1`,
    ).bind(id).first<Conv>(),
    c.env.DB.prepare(
      "SELECT id, direction, body_text, author, created_at FROM messages WHERE conversation_id = ?1 ORDER BY created_at, id",
    ).bind(id).all<Msg>(),
  ]);
  if (!conv) return c.text("Konuşma bulunamadı.", 404);
  const me = c.get("admin");
  const saved = c.req.query("kaydedildi") === "1";

  return c.html(
    "<!doctype html>" +
      (
        <AdminLayout title={conv.name || conv.email} current="/admin" adminName={me.author === "gizem" ? "Gizem" : "Baran"}>
          <header>
            <p class="eyebrow"><a href="/admin">← Konuşmalar</a></p>
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

          <section>
            <h2>Mesajlar</h2>
            <ol class="thread">
              {msgs.results.map((m) => (
                <li class={`msg msg-${m.direction}`}>
                  <p class="msg-head">
                    <span>{AUTHOR_LABEL[m.author] ?? m.author}</span>
                    <time datetime={m.created_at}>{formatTr(m.created_at, tz)}</time>
                  </p>
                  <p class="msg-body">{m.body_text ?? ""}</p>
                </li>
              ))}
            </ol>
          </section>
        </AdminLayout>
      ),
  );
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
