import { Hono } from "hono";
import llms from "../content/llms.txt";
import { isProduction, type AppEnv } from "../env";

/** The one indexable address. Static pages carry it in their canonical/OG tags too. */
export const SITE_URL = "https://uceksen.com";
export const PUBLIC_PAGES = ["/", "/rehber", "/danismanlik", "/hakkimizda", "/gizlilik", "/satis-kosullari"] as const;

/** robots.txt and sitemap.xml. Anything not in production (workers.dev staging) asks not to be crawled. */
export const seo = new Hono<AppEnv>();

seo.get("/robots.txt", (c) => {
  const body = isProduction(c.env)
    ? [
        "User-agent: *",
        // Personal pages (tokens in the URL) and the back office. They are noindex as well.
        ...["/admin/", "/api/", "/konusma/", "/randevu/", "/d/", "/odeme/"].map((p) => `Disallow: ${p}`),
        "",
        `Sitemap: ${SITE_URL}/sitemap.xml`,
      ]
    : [`# Test ortamı; dizine eklenmesin. Site: ${SITE_URL}`, "User-agent: *", "Disallow: /"];
  return c.text(`${body.join("\n")}\n`, 200, { "Cache-Control": "public, max-age=3600" });
});

seo.get("/sitemap.xml", (c) => {
  const urls = PUBLIC_PAGES.map((p) => `  <url><loc>${SITE_URL}${p}</loc></url>`).join("\n");
  return c.body(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`, 200, {
    "Content-Type": "application/xml; charset=utf-8",
    "Cache-Control": "public, max-age=3600",
  });
});

// Served by the Worker, not as a static asset: static .txt goes out without a charset and
// browsers then read the Turkish text as Windows-1252.
seo.get("/llms.txt", (c) => c.text(llms, 200, { "Cache-Control": "public, max-age=3600" }));
