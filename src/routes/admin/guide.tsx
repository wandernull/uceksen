import { Hono } from "hono";
import { csrf } from "hono/csrf";
import type { AppEnv } from "../../env";
import { requireAdmin } from "../../lib/admin-auth";
import { formatSize, serveAttachment } from "../../lib/attachments";
import { currentGuide, formatEur, notifyPurchasers, pendingNoticeCount } from "../../lib/guide";
import { getHostTz } from "../../lib/settings";
import { formatTr } from "../../lib/time";
import { randomToken } from "../../lib/tokens";
import { AdminLayout } from "../../views/layout";

/** /admin/rehber: guide PDF versions, update notices, sales. */
export const adminGuide = new Hono<AppEnv>();
adminGuide.use("*", requireAdmin);
adminGuide.use("*", csrf());

export const GUIDE_UPLOAD = { maxBytes: 50 * 1024 * 1024, version: /^[0-9A-Za-z][0-9A-Za-z.\-]{0,19}$/ } as const;

type VersionRow = { id: number; version: string; size: number | null; is_current: number; created_at: string };
type SaleRow = {
  id: number; created_at: string; amount_cents: number; currency: string; country: string | null; invoice_url: string | null;
  conversation_id: number | null; email: string; name: string | null; downloads: number;
};

const adminName = (a: { author: string }) => (a.author === "gizem" ? "Gizem" : "Baran");

async function page(c: { env: Env; get: (k: "admin") => { author: string } }, flash: { error?: string; ok?: string } = {}) {
  const db = c.env.DB;
  const [tz, versions, sales, current] = await Promise.all([
    getHostTz(db),
    db.prepare("SELECT id, version, size, is_current, created_at FROM guide_versions ORDER BY id DESC").all<VersionRow>(),
    db.prepare(
      `SELECT p.id, p.created_at, p.amount_cents, p.currency, p.country, p.invoice_url, p.conversation_id, ct.email, ct.name,
              (SELECT COALESCE(SUM(t.download_count), 0) FROM download_tokens t WHERE t.purchase_id = p.id) AS downloads
         FROM purchases p JOIN contacts ct ON ct.id = p.contact_id
        ORDER BY p.id DESC LIMIT 100`,
    ).all<SaleRow>(),
    currentGuide(db),
  ]);
  const pending = current ? await pendingNoticeCount(db, current.id) : 0;
  const total = await db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS cents FROM purchases").first<{ n: number; cents: number }>();

  return (
    "<!doctype html>" +
    (
      <AdminLayout title="Rehber" current="/admin/rehber" adminName={adminName(c.get("admin"))}>
        <header>
          <p class="eyebrow">Yönetim</p>
          <h1>Rehber</h1>
          <p class="lede">
            {current ? `Güncel sürüm: ${current.version}.` : "Henüz PDF yüklenmedi; satış kapalı."} Toplam {total?.n ?? 0} satış ·{" "}
            {formatEur(total?.cents ?? 0)}.
          </p>
        </header>

        {flash.ok && <p class="note" role="status">{flash.ok}</p>}
        {flash.error && <p class="form-error" role="alert">{flash.error}</p>}

        {current && (
          <section>
            <h2>Alıcılara bildir</h2>
            <p class="small">
              Sürüm {current.version} için {pending} kişiye henüz e-posta gitmedi. Her tıklamada en fazla 25 kişiye yeni indirme
              bağlantısıyla birlikte gönderilir; güncelleme e-postası istemeyenler atlanır.
            </p>
            {pending > 0 && (
              <form method="post" action={`/admin/rehber/surum/${current.id}/bildir`}>
                <button class="btn btn-small" type="submit">Bildir ({pending} kişi)</button>
              </form>
            )}
          </section>
        )}

        <section>
          <h2>Yeni sürüm yükle</h2>
          <form class="form-stack" method="post" action="/admin/rehber/yukle" enctype="multipart/form-data">
            <label for="g-surum">Sürüm <span class="opt">(ör. 2.0)</span></label>
            <input id="g-surum" name="surum" type="text" required maxlength={20} pattern="[0-9A-Za-z][0-9A-Za-z.\-]*" />
            <label for="g-pdf">PDF <span class="opt">(en fazla 50 MB)</span></label>
            <input id="g-pdf" name="pdf" type="file" required accept=".pdf,application/pdf" />
            <label class="check">
              <input name="guncel" type="checkbox" checked /> Yüklenince güncel sürüm yap (mevcut indirme bağlantıları da bu dosyayı verir)
            </label>
            <button class="btn" type="submit">Yükle</button>
          </form>
        </section>

        <section>
          <h2>Sürümler</h2>
          {versions.results.length === 0 ? (
            <p class="small">Henüz sürüm yok.</p>
          ) : (
            <ul class="conv-list">
              {versions.results.map((v) => (
                <li>
                  <div class="row-item">
                    <span class="conv-top">
                      <span class="conv-name">
                        <a href={`/admin/rehber/surum/${v.id}/pdf`}>Sürüm {v.version}</a>
                      </span>
                      {v.is_current ? <span class="state state-ours">Güncel</span> : null}
                    </span>
                    <span class="conv-meta">{formatTr(v.created_at, tz)} · {v.size ? formatSize(v.size) : "—"}</span>
                    {!v.is_current && (
                      <form method="post" action={`/admin/rehber/surum/${v.id}/guncel`}>
                        <button class="btn-ghost btn-small" type="submit">Güncel yap</button>
                      </form>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h2>Satışlar</h2>
          {sales.results.length === 0 ? (
            <p class="small">Henüz satış yok.</p>
          ) : (
            <ul class="conv-list">
              {sales.results.map((s) => (
                <li>
                  <div class="row-item">
                    <span class="conv-top">
                      <span class="conv-name">
                        {s.conversation_id ? <a href={`/admin/konusma/${s.conversation_id}`}>{s.name ?? s.email}</a> : (s.name ?? s.email)}
                      </span>
                      <span class="conv-meta">{formatEur(s.amount_cents, s.currency)}</span>
                    </span>
                    <span class="conv-meta">
                      {s.email} · {s.country ?? "—"} · {formatTr(s.created_at, tz)} · {s.downloads} indirme
                      {s.invoice_url ? <> · <a href={s.invoice_url} rel="noreferrer">fatura</a></> : null}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </AdminLayout>
    )
  );
}

adminGuide.get("/", async (c) => {
  const q = c.req.query();
  let ok: string | undefined;
  if (q.yuklendi) ok = `Sürüm ${q.yuklendi} yüklendi.`;
  if (q.guncel) ok = "Güncel sürüm değişti.";
  if (q.gonderilen !== undefined) {
    ok = `${q.gonderilen} kişiye gönderildi.${Number(q.hata) ? ` ${q.hata} gönderim başarısız (konuşmasından tekrar gönderilebilir).` : ""} ${q.kalan} kişi kaldı.`;
  }
  return c.html(await page(c, { ok }));
});

adminGuide.post("/yukle", async (c) => {
  const form = await c.req.formData();
  const version = String(form.get("surum") ?? "").trim();
  const file = form.get("pdf");
  const fail = async (error: string) => c.html(await page(c, { error }), 400);
  if (!GUIDE_UPLOAD.version.test(version)) return fail("Sürüm yalnızca harf, rakam, nokta ve tire içerebilir (ör. 2.0).");
  if (!file || typeof file === "string" || file.size === 0) return fail("PDF dosyası seç.");
  if (file.size > GUIDE_UPLOAD.maxBytes) return fail("Dosya 50 MB'tan büyük.");
  const bytes = await file.arrayBuffer();
  if (new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") return fail("Bu dosya PDF değil.");
  if (await c.env.DB.prepare("SELECT 1 FROM guide_versions WHERE version = ?1").bind(version).first()) {
    return fail(`Sürüm ${version} zaten var. Başka bir sürüm numarası yaz.`);
  }

  const key = `guide/${version}-${randomToken(9)}.pdf`;
  await c.env.BUCKET.put(key, bytes, { httpMetadata: { contentType: "application/pdf" } });
  const ins = await c.env.DB.prepare("INSERT INTO guide_versions (version, r2_key, size) VALUES (?1, ?2, ?3)")
    .bind(version, key, file.size).run();
  if (form.get("guncel")) await makeCurrent(c.env.DB, Number(ins.meta.last_row_id));
  return c.redirect(`/admin/rehber?yuklendi=${encodeURIComponent(version)}`, 303);
});

async function makeCurrent(db: D1Database, id: number) {
  await db.batch([
    db.prepare("UPDATE guide_versions SET is_current = 0 WHERE is_current = 1"),
    db.prepare("UPDATE guide_versions SET is_current = 1 WHERE id = ?1").bind(id),
  ]);
}

adminGuide.post("/surum/:id{[0-9]+}/guncel", async (c) => {
  const id = Number(c.req.param("id"));
  if (!(await c.env.DB.prepare("SELECT 1 FROM guide_versions WHERE id = ?1").bind(id).first())) return c.text("Sürüm bulunamadı.", 404);
  await makeCurrent(c.env.DB, id);
  return c.redirect("/admin/rehber?guncel=1", 303);
});

adminGuide.get("/surum/:id{[0-9]+}/pdf", async (c) => {
  const v = await c.env.DB.prepare("SELECT version, r2_key FROM guide_versions WHERE id = ?1")
    .bind(Number(c.req.param("id"))).first<{ version: string; r2_key: string }>();
  if (!v) return c.text("Sürüm bulunamadı.", 404);
  return serveAttachment(c.env, { r2_key: v.r2_key, filename: `uc-eksen-rehber-${v.version}.pdf`, content_type: "application/pdf" });
});

adminGuide.post("/surum/:id{[0-9]+}/bildir", async (c) => {
  const id = Number(c.req.param("id"));
  const current = await currentGuide(c.env.DB);
  if (!current || current.id !== id) return c.text("Yalnızca güncel sürüm için bildirim gönderilebilir.", 400);
  const r = await notifyPurchasers(c.env, id);
  return c.redirect(`/admin/rehber?gonderilen=${r.sent}&hata=${r.failed}&kalan=${r.remaining}`, 303);
});
