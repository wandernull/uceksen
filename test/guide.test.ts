import { env, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GUIDE } from "../src/lib/guide";
import { formEncode, signStripe, STRIPE_TOLERANCE_SEC, verifyStripeSignature } from "../src/lib/stripe";
import { fake } from "./fake-resend";
import { fakeStripe } from "./fake-stripe";
import { freshIp, messages, postWebhook } from "./helpers";

const SECRET = env.STRIPE_WEBHOOK_SECRET;
const PDF_V1 = new TextEncoder().encode("%PDF-1.7 rehber v1");
const PDF_V2 = new TextEncoder().encode("%PDF-1.7 rehber v2 — güncel");

let seq = 0;

function session(over: Record<string, unknown> = {}) {
  const id = `cs_test_${++seq}_${crypto.randomUUID().slice(0, 8)}`;
  return {
    id,
    object: "checkout.session",
    mode: "payment",
    status: "complete",
    payment_status: "paid",
    amount_total: 1500,
    currency: "eur",
    payment_intent: `pi_${id}`,
    invoice: `in_${id}`,
    metadata: { project: "uceksen", kind: "guide" },
    consent: { terms_of_service: "accepted" },
    customer_details: { email: `alici${seq}@example.com`, name: "Mehmet Demir", address: { country: "NL" } },
    ...over,
  };
}

async function postStripe(event: unknown, opts: { secret?: string; timestamp?: number; tamper?: boolean; noHeader?: boolean } = {}) {
  const body = JSON.stringify(event);
  const t = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
  const sig = await signStripe(opts.secret ?? SECRET, t, body);
  return SELF.fetch("https://example.com/api/webhooks/stripe", {
    method: "POST",
    headers: { "content-type": "application/json", ...(opts.noHeader ? {} : { "stripe-signature": `t=${t},v1=${sig}` }) },
    body: opts.tamper ? body.replace("1500", "1") : body,
  });
}

const completed = (s: ReturnType<typeof session>) => ({ id: `evt_${s.id}`, type: "checkout.session.completed", data: { object: s } });

/** A paid purchase through the webhook; returns its token and conversation. */
async function buy(over: Record<string, unknown> = {}) {
  const s = session(over);
  fakeStripe.invoices.set(s.invoice as string, { id: s.invoice as string, hosted_invoice_url: `https://invoice.stripe.com/i/${s.id}`, number: "UE-0001" });
  const res = await postStripe(completed(s));
  expect(res.status).toBe(200);
  const p = (await env.DB.prepare(
    `SELECT p.*, t.token, t.expires_at, t.max_downloads, c.reply_token, c.plus_token FROM purchases p
       JOIN download_tokens t ON t.purchase_id = p.id JOIN conversations c ON c.id = p.conversation_id
      WHERE p.stripe_session_id = ?1 ORDER BY t.id LIMIT 1`,
  ).bind(s.id).first<Record<string, string | number> & { token: string; conversation_id: number; reply_token: string; plus_token: string }>())!;
  return { s, p };
}

const adminPost = (path: string, body: FormData | string) =>
  SELF.fetch(`https://example.com${path}`, {
    method: "POST",
    headers: { origin: "https://example.com", ...(typeof body === "string" ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
    body,
    redirect: "manual",
  });

async function upload(version: string, bytes: Uint8Array, current = true) {
  const fd = new FormData();
  fd.append("surum", version);
  fd.append("pdf", new File([bytes], `rehber-${version}.pdf`, { type: "application/pdf" }));
  if (current) fd.append("guncel", "on");
  return adminPost("/admin/rehber/yukle", fd);
}

const page = (path: string, init: RequestInit = {}) =>
  SELF.fetch(`https://example.com${path}`, { redirect: "manual", ...init, headers: { origin: "https://example.com", ...init.headers } });
const download = (token: string) => page(`/d/${token}`, { method: "POST" });

describe("Stripe webhook signature", () => {
  const now = 1_800_000_000;
  const body = '{"type":"checkout.session.completed"}';

  it("accepts a valid signature, also among several (secret rotation)", async () => {
    const sig = await signStripe(SECRET, String(now), body);
    expect(await verifyStripeSignature(SECRET, `t=${now},v1=${sig}`, body, now)).toBe(true);
    expect(await verifyStripeSignature(SECRET, `t=${now},v1=${"0".repeat(64)},v1=${sig},v0=abc`, body, now)).toBe(true);
  });
  it("rejects wrong secret, tampered body, v0-only, stale/future timestamps, missing parts", async () => {
    const sig = await signStripe(SECRET, String(now), body);
    const other = await signStripe("whsec_other", String(now), body);
    expect(await verifyStripeSignature(SECRET, `t=${now},v1=${other}`, body, now)).toBe(false);
    expect(await verifyStripeSignature(SECRET, `t=${now},v1=${sig}`, body + " ", now)).toBe(false);
    expect(await verifyStripeSignature(SECRET, `t=${now},v0=${sig}`, body, now)).toBe(false);
    for (const t of [now - STRIPE_TOLERANCE_SEC - 1, now + STRIPE_TOLERANCE_SEC + 1]) {
      const s = await signStripe(SECRET, String(t), body);
      expect(await verifyStripeSignature(SECRET, `t=${t},v1=${s}`, body, now)).toBe(false);
    }
    expect(await verifyStripeSignature(SECRET, `v1=${sig}`, body, now)).toBe(false);
    expect(await verifyStripeSignature(SECRET, undefined, body, now)).toBe(false);
    expect(await verifyStripeSignature(undefined, `t=${now},v1=${sig}`, body, now)).toBe(false);
    expect(await verifyStripeSignature("", `t=${now},v1=${sig}`, body, now)).toBe(false);
  });
});

describe("guide checkout", () => {
  beforeEach(() => {
    fake.reset();
    fakeStripe.reset();
  });

  it("encodes nested Stripe params", () => {
    const p = formEncode({ a: { b: "1", c: [{ d: 2 }] }, e: true, skip: undefined });
    expect(p.toString()).toBe(new URLSearchParams({ "a[b]": "1", "a[c][0][d]": "2", e: "true" }).toString());
  });

  it("stays closed (503) while no guide PDF is current; GET goes back to /rehber", async () => {
    await env.DB.prepare("UPDATE guide_versions SET is_current = 0").run();
    const res = await page("/rehber/satin-al", { method: "POST", headers: { "cf-connecting-ip": freshIp() } });
    expect(res.status).toBe(503);
    expect(fakeStripe.sessions).toHaveLength(0);
    const get = await page("/rehber/satin-al");
    expect(get.status).toBe(303);
    expect(get.headers.get("location")).toBe("/rehber");
  });

  it("creates a Checkout session with terms consent, tax, invoice, metadata and Turkish locale", async () => {
    expect((await upload("1.0-co", PDF_V1)).status).toBe(303);
    const res = await page("/rehber/satin-al", { method: "POST", headers: { "cf-connecting-ip": freshIp() } });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    const p = fakeStripe.sessions[0]!;
    expect(p.get("mode")).toBe("payment");
    expect(p.get("line_items[0][price]")).toBe(env.STRIPE_PRICE_GUIDE);
    expect(p.get("consent_collection[terms_of_service]")).toBe("required");
    expect(p.get("custom_text[terms_of_service_acceptance][message]")).toContain("cayma hakkımı kaybettiğimi");
    expect(p.get("automatic_tax[enabled]")).toBe("true");
    expect(p.get("metadata[project]")).toBe("uceksen");
    expect(p.get("payment_intent_data[metadata][project]")).toBe("uceksen");
    expect(p.get("invoice_creation[enabled]")).toBe("true");
    expect(p.get("invoice_creation[invoice_data][footer]")).toContain("KvK 97838810");
    expect(p.get("branding_settings[display_name]")).toBe("Üç Eksen");
    expect(p.get("locale")).toBe("tr");
    expect(p.get("success_url")).toMatch(/\/rehber\/tesekkurler$/);
  });

  it("shows an error page and charges nothing when Stripe is down", async () => {
    await upload("1.0-down", PDF_V1);
    fakeStripe.fail = true;
    const res = await page("/rehber/satin-al", { method: "POST", headers: { "cf-connecting-ip": freshIp() } });
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("ödeme alınmadı");
  });
});

describe("POST /api/webhooks/stripe", () => {
  beforeAll(async () => {
    await upload("1.0", PDF_V1);
  });
  beforeEach(() => {
    fake.reset();
    fakeStripe.reset();
  });

  const purchaseCount = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM purchases").first<{ n: number }>())!.n;

  it("rejects unsigned, tampered, wrongly signed and replayed events; stores nothing", async () => {
    const before = await purchaseCount();
    const ev = completed(session());
    expect((await postStripe(ev, { noHeader: true })).status).toBe(401);
    expect((await postStripe(ev, { tamper: true })).status).toBe(401);
    expect((await postStripe(ev, { secret: "whsec_wrong" })).status).toBe(401);
    expect((await postStripe(ev, { timestamp: Math.floor(Date.now() / 1000) - 3600 })).status).toBe(401);
    expect(await purchaseCount()).toBe(before);
    expect(fake.sent).toHaveLength(0);
  });

  it("acknowledges unknown events, other projects/products and unpaid sessions without fulfilling", async () => {
    const before = await purchaseCount();
    for (const ev of [
      { type: "payment_intent.created", data: { object: { id: "pi_1" } } },
      completed(session({ metadata: { project: "other-brand", kind: "guide" } })),
      completed(session({ metadata: { project: "uceksen", kind: "consult" } })),
    ]) {
      const res = await postStripe(ev);
      expect(res.status).toBe(200);
    }
    const unpaid = await postStripe(completed(session({ payment_status: "unpaid" })));
    expect(await unpaid.json()).toMatchObject({ result: "unpaid" });
    // "No payment required" only counts when the total really is zero.
    const odd = await postStripe(completed(session({ payment_status: "no_payment_required", amount_total: 1500 })));
    expect(await odd.json()).toMatchObject({ result: "unpaid" });
    expect(await purchaseCount()).toBe(before);
  });

  it("delivers a free order (100% discount code: no_payment_required, no payment intent)", async () => {
    const { p } = await buy({ payment_status: "no_payment_required", amount_total: 0, payment_intent: null });
    expect(p).toMatchObject({ amount_cents: 0, stripe_payment_intent: null });
    expect(p.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(fake.sent.some((m) => m.text.includes(`/d/${p.token}`))).toBe(true);
  });

  it("records the purchase, creates a 7-day/5-download token and emails the link with the invoice (to DEV_EMAIL)", async () => {
    const { s, p } = await buy();
    expect(p).toMatchObject({ amount_cents: 1500, currency: "eur", country: "NL", terms_accepted: 1, max_downloads: GUIDE.maxDownloads });
    expect(p.invoice_url).toBe(`https://invoice.stripe.com/i/${s.id}`);
    expect(p.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const days = (Date.parse(String(p.expires_at)) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.99);
    expect(days).toBeLessThanOrEqual(7);

    const [delivery, note] = fake.sent;
    expect(delivery!.to).toEqual(["dev@example.com"]);
    expect(delivery!.text).toContain(`asıl alıcı: ${s.customer_details.email}`);
    expect(delivery!.subject).toBe("[TEST] Rehber siparişin — Üç Eksen");
    expect(delivery!.text).toContain("Merhaba Mehmet Demir,");
    expect(delivery!.text).toContain(`/d/${p.token}`);
    expect(delivery!.text).toContain(`Fatura: https://invoice.stripe.com/i/${s.id}`);
    expect(delivery!.text).toMatch(/Ödenen: €15,00 \(KDV dahil\)/);
    expect(delivery!.reply_to).toBe(`merhaba+${p.plus_token}@reply.uceksen.com`);
    expect(note!.subject).toContain("Yeni satış");

    const conv = await env.DB.prepare("SELECT state, source, subject FROM conversations WHERE id = ?1").bind(p.conversation_id).first();
    expect(conv).toMatchObject({ state: "completed", source: "rehber", subject: "Rehber siparişin" });
    expect((await messages(p.conversation_id))[0]).toMatchObject({ direction: "out", author: "system", via: "system", send_status: "sent" });
  });

  it("books a lira payment (Adaptive Pricing) in EUR; the customer's email shows lira", async () => {
    const { p } = await buy({
      currency: "try", amount_total: 87173, customer_details: { email: "lira@example.com", name: "Ali Veli", address: { country: "TR" } },
      currency_conversion: { amount_total: 1500, amount_subtotal: 1500, source_currency: "eur", fx_rate: "58.1153" },
    });
    expect(p).toMatchObject({ amount_cents: 1500, currency: "eur", country: "TR" });
    expect(fake.sent[0]!.text).toMatch(/Ödenen: ₺871,73 \(KDV dahil\)/);
    expect(fake.sent[1]!.text).toContain("müşteri ₺871,73 ödedi");
  });

  it("is idempotent: a redelivered event creates nothing and sends nothing", async () => {
    const { s } = await buy();
    fake.reset();
    const again = await postStripe(completed(s));
    expect(await again.json()).toMatchObject({ result: "duplicate" });
    const async = await postStripe({ type: "checkout.session.async_payment_succeeded", data: { object: s } });
    expect(await async.json()).toMatchObject({ result: "duplicate" });
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM purchases WHERE stripe_session_id = ?1").bind(s.id).first<{ n: number }>();
    expect(n!.n).toBe(1);
    expect(fake.sent).toHaveLength(0);
  });

  it("keeps the sale when the email fails; the delivery shows up as failed for a resend", async () => {
    fake.failSends = true;
    const { p } = await buy();
    expect((await messages(p.conversation_id))[0]).toMatchObject({ send_status: "failed" });
  });

  it("a repeat buyer keeps their existing name; a reply to the delivery email threads into the purchase", async () => {
    const email = "tekrar@example.com";
    const { p } = await buy({ customer_details: { email, name: "İlk İsim", address: { country: "TR" } } });
    await buy({ customer_details: { email: "TEKRAR@example.com", name: "KART SAHIBI", address: { country: "TR" } } });
    const ct = await env.DB.prepare("SELECT name FROM contacts WHERE email = ?1").bind(email).first<{ name: string }>();
    expect(ct!.name).toBe("İlk İsim");

    fake.received.set("rehber-yanit", {
      id: "rehber-yanit", from: email, to: [`merhaba+${p.plus_token}@reply.uceksen.com`], subject: "Re: Rehber siparişin",
      message_id: "<rehber-yanit@x>", text: "Dosya açılmıyor.", html: null, headers: {},
    });
    await postWebhook({ type: "email.received", data: { email_id: "rehber-yanit" } });
    expect((await messages(p.conversation_id)).at(-1)).toMatchObject({ direction: "in", body_text: "Dosya açılmıyor." });
    const st = await env.DB.prepare("SELECT state FROM conversations WHERE id = ?1").bind(p.conversation_id).first<{ state: string }>();
    expect(st!.state).toBe("ours");
  });
});

describe("/d/{token}", () => {
  beforeAll(async () => {
    await upload("1.0-d", PDF_V1);
  });
  beforeEach(() => fake.reset());

  it("GET shows the page without using a download (mail scanners); POST serves the PDF", async () => {
    const { p } = await buy();
    for (let i = 0; i < 3; i++) {
      const res = await page(`/d/${p.token}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toContain("no-store");
      expect(res.headers.get("x-robots-tag")).toContain("noindex");
      expect(await res.text()).toContain("5 indirme hakkın kaldı");
    }
    const dl = await download(p.token);
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-type")).toBe("application/pdf");
    expect(dl.headers.get("content-disposition")).toContain('attachment; filename="uc-eksen-rehber-1.0-d.pdf"');
    expect(new Uint8Array(await dl.arrayBuffer())).toEqual(PDF_V1);
    expect(await (await page(`/d/${p.token}`)).text()).toContain("4 indirme hakkın kaldı");
  });

  it("allows 5 downloads and rejects the 6th", async () => {
    const { p } = await buy();
    for (let i = 0; i < 5; i++) expect((await download(p.token)).status).toBe(200);
    const sixth = await download(p.token);
    expect(sixth.status).toBe(410);
    expect(await sixth.text()).toContain("indirme hakkı doldu");
    expect((await page(`/d/${p.token}`)).status).toBe(410);
    const t = await env.DB.prepare("SELECT download_count FROM download_tokens WHERE token = ?1").bind(p.token).first<{ download_count: number }>();
    expect(t!.download_count).toBe(5);
  });

  it("parallel clicks on the last download cannot both pass", async () => {
    const { p } = await buy();
    await env.DB.prepare("UPDATE download_tokens SET download_count = 4 WHERE token = ?1").bind(p.token).run();
    const statuses = (await Promise.all([download(p.token), download(p.token), download(p.token)])).map((r) => r.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
  });

  it("rejects an expired token", async () => {
    const { p } = await buy();
    await env.DB.prepare("UPDATE download_tokens SET expires_at = ?1 WHERE token = ?2").bind(new Date(Date.now() - 1000).toISOString(), p.token).run();
    const res = await download(p.token);
    expect(res.status).toBe(410);
    expect(await res.text()).toContain("süresi doldu");
    expect((await page(`/d/${p.token}`)).status).toBe(410);
  });

  it("404s for unknown or malformed tokens", async () => {
    expect((await page(`/d/${"x".repeat(32)}`)).status).toBe(404);
    expect((await download("x".repeat(32))).status).toBe(404);
    expect((await page("/d/short")).status).toBe(404);
  });

  it("existing tokens serve the new file once a new version is current", async () => {
    const { p } = await buy();
    expect(new Uint8Array(await (await download(p.token)).arrayBuffer())).toEqual(PDF_V1);
    await upload("2.0-d", PDF_V2);
    expect(new Uint8Array(await (await download(p.token)).arrayBuffer())).toEqual(PDF_V2);
  });
});

describe("/indir", () => {
  beforeAll(async () => {
    await upload("1.0-i", PDF_V1);
  });
  beforeEach(() => fake.reset());

  const ask = (email: string, ip = freshIp(), extra = "") =>
    page("/indir", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": ip },
      body: `email=${encodeURIComponent(email)}${extra}`,
    });

  it("emails a fresh token for the latest purchase, threaded into its conversation", async () => {
    const { s, p } = await buy();
    fake.reset();
    const res = await ask(s.customer_details.email.toUpperCase());
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/indir?gonderildi=1");
    expect(fake.sent).toHaveLength(1);
    const token = fake.sent[0]!.text.match(/\/d\/([A-Za-z0-9_-]{32})/)![1]!;
    expect(token).not.toBe(p.token);
    expect(fake.sent[0]!.subject).toBe("[TEST] Re: Rehber siparişin — Üç Eksen");
    expect((await download(token)).status).toBe(200);
  });

  it("answers the same for unknown addresses and sends nothing", async () => {
    const res = await ask("hic-almadi@example.com");
    expect(res.headers.get("location")).toBe("/indir?gonderildi=1");
    expect(fake.sent).toHaveLength(0);
  });

  it("rate-limits to 3 per hour per IP", async () => {
    const ip = "198.18.1.33";
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await ask(`kim${i}@example.com`, ip)).status);
    expect(statuses).toEqual([303, 303, 303, 429]);
  });

  it("caps emails per address across IPs, rejects bad input, honeypot sends nothing", async () => {
    const { s } = await buy();
    fake.reset();
    for (let i = 0; i < 5; i++) await ask(s.customer_details.email);
    expect(fake.sent).toHaveLength(3);
    fake.reset();
    expect((await ask("not-an-email")).status).toBe(400);
    expect((await ask(s.customer_details.email, freshIp(), "&website=http%3A%2F%2Fspam")).status).toBe(303);
    expect(fake.sent).toHaveLength(0);
  });
});

describe("guide updates", () => {
  beforeEach(() => fake.reset());

  it("admin upload rejects non-PDFs and duplicate version numbers", async () => {
    const bad = await upload("9.9", new TextEncoder().encode("MZ not a pdf"));
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("PDF değil");
    expect((await upload("9.8", PDF_V1, false)).status).toBe(303);
    expect((await upload("9.8", PDF_V1, false)).status).toBe(400);
    expect((await upload("bad version!", PDF_V1)).status).toBe(400);
  });

  it("notifies each purchaser once with a new link, skipping those who opted out", async () => {
    const a = await buy();
    const b = await buy();
    // b unsubscribes via the link in update emails; GET alone must not unsubscribe.
    expect((await page(`/konusma/${b.p.reply_token}/abonelik`)).status).toBe(200);
    expect((await env.DB.prepare("SELECT guide_updates_optout_at AS o FROM contacts WHERE email = ?1").bind(b.s.customer_details.email).first<{ o: string | null }>())!.o).toBeNull();
    const off = await page(`/konusma/${b.p.reply_token}/abonelik`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "islem=kapat",
    });
    expect(off.status).toBe(303);

    expect((await upload("3.0-n", PDF_V2)).status).toBe(303);
    const v = (await env.DB.prepare("SELECT id FROM guide_versions WHERE version = '3.0-n'").first<{ id: number }>())!;
    fake.reset();
    let res = await adminPost(`/admin/rehber/surum/${v.id}/bildir`, "");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toMatch(/kalan=0$/);
    const toA = fake.sent.filter((m) => m.text.includes(`asıl alıcı: ${a.s.customer_details.email}`));
    const toB = fake.sent.filter((m) => m.text.includes(`asıl alıcı: ${b.s.customer_details.email}`));
    expect(toA).toHaveLength(1);
    expect(toB).toHaveLength(0);
    expect(toA[0]!.text).toContain("yeni sürümü (3.0-n)");
    expect(toA[0]!.text).toContain(`/konusma/${a.p.reply_token}/abonelik`);
    const newToken = toA[0]!.text.match(/\/d\/([A-Za-z0-9_-]{32})/)![1]!;
    expect(new Uint8Array(await (await download(newToken)).arrayBuffer())).toEqual(PDF_V2);

    fake.reset();
    res = await adminPost(`/admin/rehber/surum/${v.id}/bildir`, "");
    expect(fake.sent.filter((m) => m.text.includes("yeni sürümü"))).toHaveLength(0);
  });

  it("the admin guide page lists versions and sales", async () => {
    const { s } = await buy();
    const html = await (await SELF.fetch("https://example.com/admin/rehber")).text();
    expect(html).toContain("Güncel sürüm");
    expect(html).toContain(s.customer_details.email);
    expect(html).toContain("fatura");
  });
});
