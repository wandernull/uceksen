// Browser layout check against a running server (default: wrangler dev on :8787).
// Usage: BASE_URL=http://localhost:8787 SHOTS=/some/dir node scripts/check-layout.mjs
// Uses the locally installed Google Chrome (playwright-core, channel "chrome").
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { chromium } from "playwright-core";

const BASE = process.env.BASE_URL ?? "http://localhost:8787";
const SHOTS = process.env.SHOTS; // optional screenshot directory
const PAGES = ["/", "/rehber", "/danismanlik", "/hakkimizda", "/gizlilik", "/satis-kosullari", "/indir", "/rehber/tesekkurler"];
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

// End to end: submit the request form in the browser, then find it in /admin.
let adminPages = [];
{
  const ctx = await browser.newContext({ viewport: { width: 375, height: 800 } });
  const page = await ctx.newPage();
  const stamp = Date.now();
  await page.goto(BASE + "/danismanlik");
  await page.click("[data-open]");
  checks++;
  if (await page.isVisible("#talepDone")) fail("modal open: success panel visible before submitting");
  if (await page.isVisible("#talepHata")) fail("modal open: error box visible before submitting");
  await page.fill("#f-ad", `Layout Test ${stamp}`);
  await page.fill("#f-mail", `layout-${stamp}@example.com`);
  await page.fill("#f-durum", "Tarayıcıdan gönderilen test talebi.\nİkinci satır — çok uzun bir kelime: " + "a".repeat(120));
  await page.check("#f-onay");
  await page.click("#talepForm button[type=submit]");
  await page.waitForSelector("#talepDone:not([hidden])", { timeout: 5000 }).catch(() => {});
  checks++;
  if (!(await page.isVisible("#talepDone"))) fail(`form submit: success panel not shown (error: ${await page.textContent("#talepHata")})`);
  if (await page.isVisible("#talepForm")) fail("form submit: form still visible after success");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/modal-done-375.png` });

  const res = await page.goto(BASE + "/admin/");
  checks++;
  if (res?.status() !== 200) fail(`/admin: HTTP ${res?.status()} (admin checks need ENVIRONMENT=local)`);
  else {
    const link = page.locator(`a:has-text("Layout Test ${stamp}")`);
    if ((await link.count()) !== 1) fail("/admin: submitted request not listed");
    else {
      const href = await link.getAttribute("href");
      adminPages = ["/admin/", href];
      await page.goto(BASE + href);
      await page.selectOption("#durum", "ours");
      await page.click(".state-form button");
      await page.waitForURL(/kaydedildi=1/);
      if ((await page.inputValue("#durum")) !== "ours") fail("/admin detail: state change not saved");

      // Admin reply → real Resend send (the dev guard redirects it to DEV_EMAIL).
      const customerHref = await page.locator('.facts a[href*="/konusma/"]').getAttribute("href");
      await page.fill("#metin", "Tarayıcıdan gönderilen admin yanıtı.");
      await page.click("#yanit button[type=submit]");
      await page.waitForURL(/gonderildi=/);
      checks++;
      if (!page.url().includes("gonderildi=1")) fail("/admin reply: not sent (check RESEND_API_KEY / DEV_EMAIL in .dev.vars)");

      // Customer page: reply with a file.
      const customerPath = new URL(customerHref).pathname;
      await page.goto(BASE + customerPath);
      await page.fill("#k-metin", "Müşteri sayfasından yanıt.");
      await page.setInputFiles("#k-dosya", { name: "gelir-tablosu.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 test") });
      await page.click("#yanit button[type=submit]");
      await page.waitForURL(/gonderildi=1/).catch(() => {});
      checks++;
      if (!(await page.isVisible(".note"))) fail("/konusma reply: success note not shown");
      if ((await page.locator('a:has-text("gelir-tablosu.pdf")').count()) !== 1) fail("/konusma reply: attachment not listed");
      await page.keyboard.press("Tab");
      adminPages.push(customerPath);

      // Guide: upload a PDF in /admin/rehber, simulate Stripe's signed webhook, download via /d/{token}.
      const stamp2 = Date.now().toString(36);
      await page.goto(BASE + "/admin/rehber");
      await page.fill("#g-surum", `t-${stamp2}`);
      await page.setInputFiles("#g-pdf", { name: "rehber.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 layout test") });
      await page.click('form[action="/admin/rehber/yukle"] button');
      await page.waitForURL(/yuklendi=/).catch(() => {});
      checks++;
      if (!page.url().includes("yuklendi=")) fail("/admin/rehber: upload failed");
      const secret = /^STRIPE_WEBHOOK_SECRET=(.+)$/m.exec(readFileSync(".dev.vars", "utf8"))?.[1]?.trim();
      const buyer = `layout-${stamp2}@example.com`;
      const body = JSON.stringify({ type: "checkout.session.completed", data: { object: {
        id: `cs_layout_${stamp2}`, mode: "payment", payment_status: "paid", amount_total: 1500, currency: "eur",
        payment_intent: null, invoice: null, metadata: { project: "uceksen", kind: "guide" }, consent: { terms_of_service: "accepted" },
        customer_details: { email: buyer, name: "Layout Alıcı", address: { country: "TR" } } } } });
      const t = Math.floor(Date.now() / 1000);
      const sig = createHmac("sha256", secret ?? "").update(`${t}.${body}`).digest("hex");
      const wh = await fetch(BASE + "/api/webhooks/stripe", { method: "POST", body, headers: { "stripe-signature": `t=${t},v1=${sig}` } });
      checks++;
      if (wh.status !== 200) fail(`stripe webhook: HTTP ${wh.status} (STRIPE_WEBHOOK_SECRET in .dev.vars?)`);
      await page.goto(BASE + "/admin/rehber");
      const saleHref = await page.locator(`.conv-list a:has-text("Layout Alıcı")`).first().getAttribute("href").catch(() => null);
      if (!saleHref) fail("/admin/rehber: sale not listed");
      else {
        adminPages.push("/admin/rehber");
        await page.goto(BASE + saleHref);
        const dPath = (await page.locator(".msg-body").first().textContent())?.match(/\/d\/[A-Za-z0-9_-]{32}/)?.[0];
        checks++;
        if (!dPath) fail("delivery message has no /d/ link");
        else {
          await page.goto(BASE + dPath);
          const [dl] = await Promise.all([page.waitForEvent("download"), page.click("form button")]);
          if (dl.suggestedFilename() !== `uc-eksen-rehber-t-${stamp2}.pdf`) fail(`/d download: filename ${dl.suggestedFilename()}`);
          adminPages.push(dPath);
        }
      }
    }
  }
  await ctx.close();
}
for (const [theme, expected] of Object.entries(THEMES)) {
  for (const width of [320, 375, 1280]) {
    const ctx = await browser.newContext({ viewport: { width, height: 800 }, colorScheme: theme });
    const page = await ctx.newPage();
    for (const path of adminPages) {
      const where = `${path} @${width}px ${theme}`;
      await page.goto(BASE + path, { waitUntil: "networkidle" });
      checks++;
      const m = await page.evaluate(() => ({
        scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth,
        bg: getComputedStyle(document.body).backgroundColor,
      }));
      if (m.scrollW > m.clientW) fail(`${where}: horizontal scroll (${m.scrollW} > ${m.clientW})`);
      if (m.bg !== expected.paper) fail(`${where}: body background ${m.bg}`);
      if (SHOTS && width !== 1280) {
        const name = path === "/admin/" ? "admin-list" : path === "/admin/rehber" ? "admin-rehber" : path.startsWith("/d/") ? "indir-token" : path.startsWith("/konusma/") ? "konusma" : "admin-detail";
        await page.screenshot({ path: `${SHOTS}/${name}-${width}-${theme}.png`, fullPage: true });
      }
    }
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
console.log(`${checks} checks (${PAGES.length} pages × ${WIDTHS.length} widths × 2 themes, form → admin → reply → customer page → guide upload/purchase/download flow, admin + /konusma pages × 3 widths × 2 themes, modal)`);
if (failures.length) {
  console.error(`FAILED (${failures.length}):\n` + failures.map((f) => "  - " + f).join("\n"));
  process.exit(1);
}
console.log("all layout checks passed");
