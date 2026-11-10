// Renders the share image and icons into public/ with the site's own fonts and colours.
// Usage: node scripts/render-brand.mjs   (needs system Chrome, like test:layout)
import { chromium } from "playwright-core";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const pub = join(root, "public");
// The site's @font-face rules with the files inlined (Chrome blocks fonts over file://).
const fontCss = readFileSync(join(pub, "fonts/fonts.css"), "utf8").replace(/url\(["']?([^)"']+\.woff2)["']?\)/g, (_, f) =>
  `url(data:font/woff2;base64,${readFileSync(join(pub, "fonts", f.replace(/^.*\//, ""))).toString("base64")})`);
const tmp = mkdtempSync(join(tmpdir(), "uceksen-brand-"));

// Light theme tokens from styles.css.
const C = { paper: "#F4F4F1", ink: "#1B1D18", muted: "#6E7268", rule: "#D6D6CE", accent: "#3A5A40" };
const base = `<style>${fontCss}</style><style>
  html,body{margin:0}
  .display{font-family:"Archivo",sans-serif;font-weight:700}
  .mono{font-family:"IBM Plex Mono",monospace;font-weight:500;text-transform:uppercase;letter-spacing:.08em}
</style>`;

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ deviceScaleFactor: 1 });

async function shot(html, w, h) {
  const file = join(tmp, "p.html");
  writeFileSync(file, `<!doctype html><html lang="tr"><meta charset="utf-8">${base}${html}`);
  await page.setViewportSize({ width: w, height: h });
  await page.goto(`file://${file}`, { waitUntil: "load" });
  await page.evaluate(async () => {
    await Promise.all(['700 80px "Archivo"', '500 20px "IBM Plex Mono"'].map((f) => document.fonts.load(f, "ÜçşığĞİ")));
    await document.fonts.ready;
  });
  return page.screenshot({ clip: { x: 0, y: 0, width: w, height: h } });
}

// Share image (Open Graph / X), 1200×630.
writeFileSync(join(pub, "og.png"), await shot(`
  <div style="box-sizing:border-box;width:1200px;height:630px;background:${C.paper};color:${C.ink};padding:72px 80px;display:flex;flex-direction:column;justify-content:space-between">
    <div class="mono" style="color:${C.accent};font-size:24px">Avrupa’ya açılan Türkler için</div>
    <div class="display" style="font-size:84px;line-height:1.04;letter-spacing:-.01em;max-width:1000px">Oturum, vergi ve şirket üç ayrı karardır</div>
    <div style="display:flex;justify-content:space-between;align-items:baseline;border-top:2px solid ${C.rule};padding-top:28px">
      <span class="display" style="font-size:34px;text-transform:uppercase;letter-spacing:.04em">Üç Eksen</span>
      <span class="mono" style="color:${C.muted};font-size:22px;text-transform:none;letter-spacing:.02em">uceksen.com</span>
    </div>
  </div>`, 1200, 630));

// Square icon: accent green with paper-coloured initials (same as the Stripe icon).
const icon = (s) => shot(`
  <div style="width:${s}px;height:${s}px;background:${C.accent};display:flex;align-items:center;justify-content:center">
    <span class="display" style="color:${C.paper};font-size:${Math.round(s * 0.45)}px;letter-spacing:0;line-height:1">ÜE</span>
  </div>`, s, s);
const png = {};
for (const s of [16, 32, 48, 180, 192, 512]) png[s] = await icon(s);
writeFileSync(join(pub, "apple-touch-icon.png"), png[180]);
writeFileSync(join(pub, "icon-192.png"), png[192]);
writeFileSync(join(pub, "icon-512.png"), png[512]);

// favicon.ico with PNG-encoded 16/32/48 images.
const sizes = [16, 32, 48];
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
let offset = 6 + 16 * sizes.length;
const dir = [], data = [];
for (const s of sizes) {
  const e = Buffer.alloc(16);
  e.writeUInt8(s, 0); e.writeUInt8(s, 1); e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
  e.writeUInt32LE(png[s].length, 8); e.writeUInt32LE(offset, 12);
  offset += png[s].length;
  dir.push(e); data.push(png[s]);
}
writeFileSync(join(pub, "favicon.ico"), Buffer.concat([header, ...dir, ...data]));

await browser.close();
console.log("wrote og.png, favicon.ico, apple-touch-icon.png, icon-192.png, icon-512.png");
