import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const PAGES: [path: string, title: string][] = [
  ["/", "Üç Eksen — Avrupa’ya açılan Türkler için oturum, vergi ve şirket"],
  ["/rehber", "Üç Eksen rehberi — Avrupa’da oturum, vergi ve şirketin kurulma sırası"],
  ["/danismanlik", "Durum Analizi — birebir danışmanlık | Üç Eksen"],
  ["/hakkimizda", "Hakkımızda — Üç Eksen"],
  ["/gizlilik", "Gizlilik — Üç Eksen"],
  ["/satis-kosullari", "Satış Koşulları — Üç Eksen"],
];

const get = (path: string) => SELF.fetch(`https://example.com${path}`, { redirect: "manual" });

describe("static pages", () => {
  for (const [path, title] of PAGES) {
    it(`${path} renders`, async () => {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      const html = await res.text();
      expect(html.startsWith("<!doctype html>")).toBe(true);
      expect(html).toContain('<html lang="tr">');
      expect(html).toContain('name="viewport"');
      expect(html).toContain(`<title>${title}</title>`);
      // No third-party font CDN, no leftover prototype links or placeholders.
      expect(html).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
      expect(html).not.toMatch(/href="[^"]*\.html"/);
      expect(html.replace(/<script[^>]*>[\s\S]*?<\/script>/g, "")).not.toMatch(/\[[^\]]+\]/);
      // Same nav everywhere; current page marked.
      const nav = html.match(/<div class="nav-links">([\s\S]*?)<\/div>/)?.[1] ?? "";
      expect([...nav.matchAll(/href="([^"]+)"/g)].map((m) => m[1])).toEqual(["/rehber", "/danismanlik", "/hakkimizda"]);
      if (["/rehber", "/danismanlik", "/hakkimizda"].includes(path)) {
        expect(nav).toContain(`href="${path}" aria-current="page"`);
      } else {
        expect(nav).not.toContain("aria-current");
      }
    });
  }

  it("redirects .html URLs to clean URLs", async () => {
    const res = await get("/rehber.html");
    expect([301, 307, 308]).toContain(res.status);
    expect(new URL(res.headers.get("location")!, "https://example.com").pathname).toBe("/rehber");
  });

  it("legal pages carry the company details", async () => {
    for (const path of ["/gizlilik", "/satis-kosullari"]) {
      const html = await (await get(path)).text();
      expect(html).toContain("Back of the Envelope B.V.");
      expect(html).toContain("KvK: 97838810 · BTW: NL868254010B01");
    }
    expect(await (await get("/satis-kosullari")).text()).toContain("yetkili mahkemeler Amsterdam, Hollanda");
  });

  it("guide page: €15 launch price, no Stripe placeholder", async () => {
    const html = await (await get("/rehber")).text();
    expect(html).toContain('<span class="price">€15</span>');
    expect(html).toContain("Lansman fiyatı. 1 Şubat 2027'den itibaren €30.");
    expect(html).not.toContain("<s>"); // no crossed-out reference price (EU price rules)
    expect(html).not.toContain("REPLACE_ME");
    expect(html).toContain('<form method="post" action="/rehber/satin-al">');
  });

  it("consulting: €100 launch price on the page and in the terms; the home page shows no prices", async () => {
    const d = await (await get("/danismanlik")).text();
    expect(d).toContain('<span class="price">€100</span>');
    expect(d).toContain("1 Şubat 2027'den itibaren €200.");
    expect(await (await get("/satis-kosullari")).text()).toContain("Fiyat €100'dür (lansman fiyatı; 1 Şubat 2027'den itibaren €200)");
    expect(await (await get("/")).text()).not.toContain("€");
  });

  it("serves the stylesheets and fonts", async () => {
    for (const path of ["/styles.css", "/site.css", "/fonts/fonts.css", "/fonts/archivo-latin-ext.woff2"]) {
      expect((await get(path)).status, path).toBe(200);
    }
  });

  it("buying answers 503 in Turkish while no guide PDF is uploaded", async () => {
    const res = await SELF.fetch("https://example.com/rehber/satin-al", { method: "POST", headers: { origin: "https://example.com" } });
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("Satış çok yakında açılıyor");
  });

  it("terms page links the fresh-link page", async () => {
    expect(await (await get("/satis-kosullari")).text()).toContain('<a href="/indir">siteden</a>');
  });
});
