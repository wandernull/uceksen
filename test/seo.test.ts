import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import app from "../src/index";
import { PUBLIC_PAGES, SITE_URL } from "../src/routes/seo";

const get = (path: string) => SELF.fetch(`https://example.com${path}`, { redirect: "manual" });
const attr = (html: string, re: RegExp) => html.match(re)?.[1];
const jsonLd = (html: string) => {
  const m = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  expect(m).toHaveLength(1);
  return JSON.parse(m[0]![1]!) as { "@graph": Record<string, any>[] }; // eslint-disable-line @typescript-eslint/no-explicit-any
};

describe("search engines and AI agents", () => {
  for (const path of PUBLIC_PAGES) {
    it(`${path}: description, canonical, Open Graph, structured data, icons`, async () => {
      const html = await (await get(path)).text();
      const desc = attr(html, /<meta name="description" content="([^"]+)">/);
      expect(desc && desc.length).toBeGreaterThan(60);
      expect(desc!.length).toBeLessThanOrEqual(200);
      expect(attr(html, /<link rel="canonical" href="([^"]+)">/)).toBe(`${SITE_URL}${path}`);
      expect(attr(html, /<meta property="og:url" content="([^"]+)">/)).toBe(`${SITE_URL}${path}`);
      expect(attr(html, /<meta property="og:image" content="([^"]+)">/)).toBe(`${SITE_URL}/og.png`);
      expect(attr(html, /<meta property="og:title" content="([^"]+)">/)).toBeTruthy();
      expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
      expect(html).toContain('<link rel="icon" href="/favicon.ico"');
      expect(html).not.toContain("noindex");
      const types = jsonLd(html)["@graph"].map((n) => n["@type"]);
      expect(types).toEqual(expect.arrayContaining(["Organization", "WebSite"]));
    });
  }

  it("structured prices match the visible launch prices", async () => {
    const r = await (await get("/rehber")).text();
    const product = jsonLd(r)["@graph"].find((n) => n["@type"] === "Product")!;
    expect(product.offers).toMatchObject({ price: "15.00", priceCurrency: "EUR", priceValidUntil: "2027-01-31" });
    expect(product.offers.priceSpecification.valueAddedTaxIncluded).toBe(true);
    expect(r).toContain('<span class="price">€15</span>');
    const d = await (await get("/danismanlik")).text();
    const service = jsonLd(d)["@graph"].find((n) => n["@type"] === "Service")!;
    expect(service.offers).toMatchObject({ price: "100.00", priceCurrency: "EUR", priceValidUntil: "2027-01-31" });
    expect(d).toContain('<span class="price">€100</span>');
    const org = jsonLd(d)["@graph"].find((n) => n["@type"] === "Organization")!;
    expect(org).toMatchObject({ legalName: "Back of the Envelope B.V.", vatID: "NL868254010B01" });
  });

  it("the sitemap lists exactly the public pages on the real domain", async () => {
    const res = await get("/sitemap.xml");
    expect(res.headers.get("content-type")).toContain("application/xml");
    const locs = [...(await res.text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(locs).toEqual(PUBLIC_PAGES.map((p) => `${SITE_URL}${p}`));
  });

  it("robots.txt: staging asks not to be crawled; production allows it, hides personal pages and names the sitemap", async () => {
    const staging = await (await get("/robots.txt")).text();
    expect(staging).toMatch(/User-agent: \*\nDisallow: \/\n/);
    const prod = await (await app.fetch(new Request("https://uceksen.com/robots.txt"), { ...env, ENVIRONMENT: "production" })).text();
    expect(prod).not.toMatch(/Disallow: \/\n/);
    for (const p of ["/admin/", "/konusma/", "/randevu/", "/d/"]) expect(prod).toContain(`Disallow: ${p}`);
    expect(prod).toContain(`Sitemap: ${SITE_URL}/sitemap.xml`);
    expect(prod).not.toMatch(/GPTBot|ClaudeBot|PerplexityBot/); // AI agents are welcome
  });

  it("serves the icons, the share image and llms.txt", async () => {
    for (const [path, type] of [["/favicon.ico", "image/"], ["/og.png", "image/png"], ["/apple-touch-icon.png", "image/png"], ["/icon-512.png", "image/png"]]) {
      const res = await get(path!);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type"), path).toContain(type!);
    }
    const res = await get("/llms.txt");
    expect(res.headers.get("content-type")).toMatch(/text\/plain; charset=utf-8/i);
    const llms = await res.text();
    expect(llms).toContain("Avrupa’ya açılan Türkler için Türkçe bir kaynak");
    expect(llms.startsWith("# Üç Eksen\n")).toBe(true);
    for (const p of ["/rehber", "/danismanlik"]) expect(llms).toContain(`](${SITE_URL}${p})`);
    expect(llms).toContain("€15");
    expect(llms).toContain("€100");
  });

  it("dynamic pages carry the icons too", async () => {
    expect(await (await get("/indir")).text()).toContain('<link rel="icon" href="/favicon.ico"');
  });
});
