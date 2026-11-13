import { Hono } from "hono";
import { csrf } from "hono/csrf";
import type { AppEnv } from "../../env";
import { requireAdmin } from "../../lib/admin-auth";
import { createPromo, deactivatePromo, listPromos, parsePromoForm, PRODUCT_LABEL, PromoTakenError, type Promo, type PromoError } from "../../lib/promo";
import { getHostTz } from "../../lib/settings";
import { formatTr } from "../../lib/time";
import { AdminLayout } from "../../views/layout";

/** /admin/kodlar: create, list and deactivate discount codes (Stripe promotion codes). */
export const adminPromos = new Hono<AppEnv>();
adminPromos.use("*", requireAdmin);
adminPromos.use("*", csrf());

const ERRORS: Record<PromoError, string> = {
  code: "Kod 4–20 karakter olmalı: yalnızca A–Z harfleri ve rakamlar.",
  value: "İndirim: yüzde için 1–100, tutar için €1–200 arası tam sayı.",
  max: "Kullanım limiti 1–1000 arası tam sayı olmalı (ya da boş).",
  expiry: "Son geçerlilik tarihi bugünden sonra olmalı.",
  taken: "Bu kod zaten var. Başka bir kod yaz ya da boş bırak.",
  stripe: "Stripe kodu oluşturamadı. Biraz sonra tekrar dene.",
};

export function promoMeta(p: Promo, tz: string): string {
  const uses = p.maxRedemptions ? `${p.timesRedeemed}/${p.maxRedemptions} kullanım` : `${p.timesRedeemed} kullanım`;
  const until = p.expiresAt ? ` · son: ${formatTr(p.expiresAt, tz)}` : "";
  return `${p.label} · ${PRODUCT_LABEL[p.product]} · ${uses}${until}`;
}

adminPromos.get("/", async (c) => {
  const tz = await getHostTz(c.env.DB);
  const err = c.req.query("hata") as PromoError | undefined;
  const created = c.req.query("olusturuldu");
  let promos: Promo[] = [];
  let listFailed = false;
  try {
    promos = await listPromos(c.env);
  } catch (e) {
    console.error("listing promotion codes failed", e);
    listFailed = true;
  }
  const me = c.get("admin");
  return c.html(
    "<!doctype html>" +
      (
        <AdminLayout title="İndirim kodları" current="/admin/kodlar" adminName={me.author === "gizem" ? "Gizem" : "Baran"}>
          <header>
            <p class="eyebrow">Yönetim</p>
            <h1>İndirim kodları</h1>
            <p class="lede">Kodu müşteri Stripe ödeme sayfasında “Promosyon kodu ekle”ye yazar. Bir konuşmadan e-postayla da gönderebilirsin.</p>
          </header>

          {created && <p class="note" role="status">Kod oluşturuldu: <strong>{created}</strong></p>}
          {err && ERRORS[err] && <p class="form-error" role="alert">{ERRORS[err]}</p>}

          <section>
            <h2>Yeni kod</h2>
            <form class="form-stack" method="post" action="/admin/kodlar/yeni">
              <label for="p-kod">Kod <span class="opt">(boş bırakırsan rastgele üretilir)</span></label>
              <input id="p-kod" name="kod" type="text" maxlength={20} pattern="[A-Za-z0-9]{4,20}" autocomplete="off" />
              <label for="p-tur">İndirim türü</label>
              <select id="p-tur" name="tur">
                <option value="yuzde">Yüzde (%)</option>
                <option value="tutar">Tutar (€)</option>
              </select>
              <label for="p-deger">İndirim <span class="opt">(yüzde: 1–100, tutar: €1–200)</span></label>
              <input id="p-deger" name="deger" type="number" min={1} max={200} step={1} required />
              <label for="p-urun">Geçerli olduğu ürün</label>
              <select id="p-urun" name="urun">
                <option value="rehber">Rehber</option>
                <option value="danismanlik">Durum Analizi</option>
                <option value="ikisi">İkisi de</option>
              </select>
              <label for="p-limit">Kullanım limiti <span class="opt">(toplam; boş = sınırsız)</span></label>
              <input id="p-limit" name="limit" type="number" min={1} max={1000} step={1} />
              <label for="p-son">Son geçerlilik <span class="opt">(o günün sonuna kadar, {tz}; boş = süresiz)</span></label>
              <input id="p-son" name="son" type="date" />
              <button class="btn" type="submit">Kodu oluştur</button>
            </form>
          </section>

          <section>
            <h2>Aktif kodlar</h2>
            {listFailed ? (
              <p class="form-error" role="alert">Kodlar Stripe'tan alınamadı.</p>
            ) : promos.length === 0 ? (
              <p class="small">Aktif kod yok.</p>
            ) : (
              <ul class="conv-list">
                {promos.map((p) => (
                  <li>
                    <div class="row-item">
                      <span class="conv-top">
                        <span class="conv-name"><code>{p.code}</code></span>
                      </span>
                      <span class="conv-meta">{promoMeta(p, tz)}</span>
                      <form method="post" action={`/admin/kodlar/${encodeURIComponent(p.id)}/kapat`}>
                        <button class="btn-ghost btn-small" type="submit">Kapat</button>
                      </form>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </AdminLayout>
      ),
  );
});

adminPromos.post("/yeni", async (c) => {
  const body = await c.req.parseBody();
  const parsed = parsePromoForm(body, await getHostTz(c.env.DB));
  if (!parsed.ok) return c.redirect(`/admin/kodlar?hata=${parsed.error}`, 303);
  try {
    const p = await createPromo(c.env, { ...parsed.input, createdBy: c.get("admin").author });
    return c.redirect(`/admin/kodlar?olusturuldu=${encodeURIComponent(p.code)}`, 303);
  } catch (e) {
    if (e instanceof PromoTakenError) return c.redirect("/admin/kodlar?hata=taken", 303);
    console.error("creating promotion code failed", e);
    return c.redirect("/admin/kodlar?hata=stripe", 303);
  }
});

adminPromos.post("/:id/kapat", async (c) => {
  const id = c.req.param("id");
  if (!/^promo_[A-Za-z0-9]+$/.test(id)) return c.text("Geçersiz kod.", 400);
  await deactivatePromo(c.env, id);
  return c.redirect("/admin/kodlar", 303);
});
