// Browser layout check against a running server (default: wrangler dev on :8787).
// Usage: BASE_URL=http://localhost:8787 SHOTS=/some/dir node scripts/check-layout.mjs
// Uses the locally installed Google Chrome (playwright-core, channel "chrome").
import { chromium } from "playwright-core";

const BASE = process.env.BASE_URL ?? "http://localhost:8787";
const SHOTS = process.env.SHOTS; // optional screenshot directory
const PAGES = ["/", "/rehber", "/danismanlik", "/hakkimizda", "/gizlilik", "/satis-kosullari"];
const WIDTHS = [320, 375, 414, 1280];
const THEMES = { light: { paper: "rgb(244, 244, 241)" }, dark: { paper: "rgb(18, 20, 16)" } };

const browser = await chromium.launch({ channel: "chrome" });
const failures = [];
let checks = 0;
const fail = (msg) => failures.push(msg);

for (const [theme, expected] of Object.entries(THEMES)) {
  for (const width of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width, height: 800 }, colorScheme: theme });
    const page = await ctx.newPage();
    const external = [];
    page.on("request", (r) => {
      const u = new URL(r.url());
      if (u.origin !== new URL(BASE).origin) external.push(u.href);
    });
    for (const path of PAGES) {
      const where = `${path} @${width}px ${theme}`;
      const res = await page.goto(BASE + path, { waitUntil: "networkidle" });
      await page.evaluate(() => document.fonts.ready);
      checks++;
      if (res?.status() !== 200) fail(`${where}: HTTP ${res?.status()}`);

      const m = await page.evaluate(() => {
        const de = document.documentElement;
        const cs = getComputedStyle(document.body);
        const offenders = [...document.querySelectorAll("body *")]
          .filter((el) => el.getBoundingClientRect().right > de.clientWidth + 0.5)
          .slice(0, 3)
          .map((el) => `${el.tagName.toLowerCase()}.${el.className}`);
        const gutter = Math.min(...[...document.querySelectorAll(".gutter")].map((g) => parseFloat(getComputedStyle(g).paddingLeft)));
        return {
          scrollW: de.scrollWidth, clientW: de.clientWidth, offenders, gutter,
          bg: cs.backgroundColor,
          fonts: [["Archivo", 700], ["Source Serif 4", 400], ["IBM Plex Mono", 400]].map(([f, w]) => [f, document.fonts.check(`${w} 16px "${f}"`, "ğüşıöçİ")]),
        };
      });
      if (m.scrollW > m.clientW) fail(`${where}: horizontal scroll (${m.scrollW} > ${m.clientW}) — ${m.offenders.join(", ")}`);
      if (m.gutter < 16) fail(`${where}: side gutter ${m.gutter}px < 16px`);
      if (m.bg !== expected.paper) fail(`${where}: body background ${m.bg}, expected ${expected.paper}`);
      for (const [f, ok] of m.fonts) if (!ok) fail(`${where}: font "${f}" not loaded`);

      // Keyboard focus: first Tab lands on the brand link and must draw an outline.
      await page.keyboard.press("Tab");
      const focus = await page.evaluate(() => {
        const el = document.activeElement;
        const cs = el ? getComputedStyle(el) : null;
        return { tag: el?.tagName, outline: cs ? `${cs.outlineStyle} ${cs.outlineWidth}` : "" };
      });
      if (!focus.outline.startsWith("solid") || focus.outline.endsWith(" 0px")) fail(`${where}: focus not visible on ${focus.tag} (${focus.outline})`);

      if (SHOTS && (width === 375 || width === 1280)) {
        const name = (path === "/" ? "index" : path.slice(1)) + `-${width}-${theme}.png`;
        await page.screenshot({ path: `${SHOTS}/${name}`, fullPage: true });
      }
    }
    if (external.length) fail(`@${width}px ${theme}: external requests: ${[...new Set(external)].join(", ")}`);
    await ctx.close();
  }
}

// The contact modal must also fit on the smallest phone.
{
  const ctx = await browser.newContext({ viewport: { width: 320, height: 640 } });
  const page = await ctx.newPage();
  await page.goto(BASE + "/danismanlik");
  await page.click("[data-open]");
  const box = await page.locator("#talepModal").boundingBox();
  checks++;
  if (!box || box.x < 0 || box.x + box.width > 320) fail(`modal @320px overflows: ${JSON.stringify(box)}`);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/modal-320.png` });
  await ctx.close();
}

await browser.close();
console.log(`${checks} page renders checked (${PAGES.length} pages × ${WIDTHS.length} widths × 2 themes + modal)`);
if (failures.length) {
  console.error(`FAILED (${failures.length}):\n` + failures.map((f) => "  - " + f).join("\n"));
  process.exit(1);
}
console.log("all layout checks passed");
