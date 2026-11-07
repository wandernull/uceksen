import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const PAGES: [path: string, title: string][] = [
  ["/", "Üç Eksen"],
  ["/rehber", "Rehber — Üç Eksen"],
  ["/danismanlik", "Danışmanlık — Üç Eksen"],
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
      expect(html.replace(/<script>[\s\S]*?<\/script>/g, "")).not.toMatch(/\[[^\]]+\]/);
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

  it("guide page has no launch-price note and no Stripe placeholder", async () => {
    const html = await (await get("/rehber")).text();
    expect(html).not.toContain("€29");
    expect(html).not.toContain("REPLACE_ME");
    expect(html).toContain('href="/rehber/satin-al"');
  });

  it("serves the stylesheets and fonts", async () => {
    for (const path of ["/styles.css", "/site.css", "/fonts/fonts.css", "/fonts/archivo-latin-ext.woff2"]) {
      expect((await get(path)).status, path).toBe(200);
    }
  });

  it("buy placeholder answers 503 in Turkish until Phase 4", async () => {
    const res = await get("/rehber/satin-al");
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("Satış çok yakında açılıyor");
  });
});
