import { env, SELF } from "cloudflare:test";
import { DateTime } from "luxon";
import { beforeEach, describe, expect, it } from "vitest";
import { generateCode, parsePromoForm, promoBody, PROMO } from "../src/lib/promo";
import { createConsultCheckout, createGuideCheckout, formEncode } from "../src/lib/stripe";
import { fake } from "./fake-resend";
import { fakeStripe } from "./fake-stripe";
import { freshIp, messages, newConversation } from "./helpers";

const req = (path: string, init: RequestInit = {}) =>
  SELF.fetch(`https://example.com${path}`, { redirect: "manual", ...init, headers: { origin: "https://example.com", "cf-connecting-ip": freshIp(), ...init.headers } });
const form = (path: string, body: Record<string, string>) =>
  req(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() });

const lastCoupon = () => [...fakeStripe.coupons.values()].at(-1)!;
const lastPromo = () => [...fakeStripe.promos.values()].at(-1)!;

beforeEach(() => {
  fakeStripe.reset();
  fake.reset();
});

describe("parsePromoForm", () => {
  const now = DateTime.fromISO("2026-11-13T10:00:00Z");
  const ok = (body: Record<string, string>) => parsePromoForm(body, "Europe/Istanbul", now);

  it("normalises a percent code for the guide", () => {
    expect(ok({ kod: "lansman100", tur: "yuzde", deger: "100", urun: "rehber" })).toEqual({
      ok: true,
      input: { code: "LANSMAN100", kind: "percent", value: 100, product: "guide", expiresAt: null, maxRedemptions: null },
    });
  });

  it("amount off, both products, limit, and an expiry at the end of that day in the host zone", () => {
    const r = ok({ kod: "", tur: "tutar", deger: "20", urun: "ikisi", limit: "5", son: "2026-12-31" });
    expect(r).toEqual({
      ok: true,
      input: { code: undefined, kind: "amount", value: 20, product: "both", maxRedemptions: 5, expiresAt: "2026-12-31T20:59:59.999Z" },
    });
    // Across the EU DST change: end of 31 March in Amsterdam is 21:59:59Z (CEST, UTC+2).
    const dst = parsePromoForm({ tur: "yuzde", deger: "10", son: "2027-03-31" }, "Europe/Amsterdam", now);
    expect(dst.ok && dst.input.expiresAt).toBe("2027-03-31T21:59:59.999Z");
  });

  it("rejects bad codes, values, limits and past dates", () => {
    expect(ok({ kod: "ab", tur: "yuzde", deger: "10" })).toEqual({ ok: false, error: "code" });
    expect(ok({ kod: "İNDİRİM", tur: "yuzde", deger: "10" })).toEqual({ ok: false, error: "code" });
    expect(ok({ kod: "KOD-1", tur: "yuzde", deger: "10" })).toEqual({ ok: false, error: "code" });
    for (const deger of ["0", "101", "12.5", "", "x"]) expect(ok({ tur: "yuzde", deger })).toEqual({ ok: false, error: "value" });
    expect(ok({ tur: "tutar", deger: "201" })).toEqual({ ok: false, error: "value" });
    expect(ok({ tur: "yuzde", deger: "10", limit: "0" })).toEqual({ ok: false, error: "max" });
    expect(ok({ tur: "yuzde", deger: "10", limit: String(PROMO.maxRedemptions + 1) })).toEqual({ ok: false, error: "max" });
    expect(ok({ tur: "yuzde", deger: "10", son: "2026-11-12" })).toEqual({ ok: false, error: "expiry" });
    expect(ok({ tur: "yuzde", deger: "10", son: "not-a-date" })).toEqual({ ok: false, error: "expiry" });
  });

  it("generated codes use an unambiguous alphabet", () => {
    for (let i = 0; i < 50; i++) expect(generateCode()).toMatch(/^[A-HJKMNP-Z2-9]{8}$/);
  });
});

describe("form encoding", () => {
  it("encodes arrays of strings as indexed keys (applies_to[products][0])", () => {
    expect(formEncode({ applies_to: { products: ["prod_a", "prod_b"] } }).toString()).toBe(
      "applies_to%5Bproducts%5D%5B0%5D=prod_a&applies_to%5Bproducts%5D%5B1%5D=prod_b",
    );
  });
});

describe("checkout accepts codes", () => {
  it("both checkouts allow promotion codes", async () => {
    await createGuideCheckout(env);
    await createConsultCheckout(env, { conversationId: 1, email: "a@example.com", replyToken: "r" });
    expect(fakeStripe.sessions.map((s) => s.get("allow_promotion_codes"))).toEqual(["true", "true"]);
  });
});

describe("/admin/kodlar", () => {
  it("creates a coupon + promotion code limited to the product, then lists and closes it", async () => {
    const res = await form("/admin/kodlar/yeni", { kod: "deneme100", tur: "yuzde", deger: "100", urun: "rehber", limit: "1", son: "2027-01-31" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/admin/kodlar?olusturuldu=DENEME100");

    expect(lastCoupon()).toMatchObject({
      duration: "once", percent_off: "100", name: "%100 indirim",
      "applies_to[products][0]": env.STRIPE_PRODUCT_GUIDE, "metadata[project]": "uceksen", "metadata[product]": "guide",
    });
    expect(lastCoupon()["applies_to[products][1]"]).toBeUndefined();
    const p = lastPromo();
    expect(p).toMatchObject({ code: "DENEME100", max_redemptions: 1, active: true });
    expect(p.coupon).toMatch(/^cp_/);
    expect(p.expires_at).toBe(Math.floor(Date.parse("2027-01-31T20:59:59.999Z") / 1000));

    const page = await (await req("/admin/kodlar")).text();
    expect(page).toContain("DENEME100");
    expect(page).toContain("%100 indirim · Rehber · 0/1 kullanım");

    expect((await form(`/admin/kodlar/${p.id}/kapat`, {})).status).toBe(303);
    expect(fakeStripe.promos.get(p.id)!.active).toBe(false);
    expect(await (await req("/admin/kodlar")).text()).not.toContain("DENEME100");
  });

  it("amount codes for both products; an empty code is generated", async () => {
    await form("/admin/kodlar/yeni", { kod: "", tur: "tutar", deger: "20", urun: "ikisi" });
    expect(lastCoupon()).toMatchObject({
      amount_off: "2000", currency: "eur", name: "€20 indirim",
      "applies_to[products][0]": env.STRIPE_PRODUCT_GUIDE, "applies_to[products][1]": env.STRIPE_PRODUCT_CONSULT,
    });
    expect(lastPromo().code).toMatch(/^[A-HJKMNP-Z2-9]{8}$/);
    expect(lastPromo().max_redemptions).toBeNull();
  });

  it("a taken code shows an error and leaves no orphaned coupon", async () => {
    await form("/admin/kodlar/yeni", { kod: "AYNI", tur: "yuzde", deger: "10" });
    expect(fakeStripe.coupons.size).toBe(1);
    const res = await form("/admin/kodlar/yeni", { kod: "ayni", tur: "yuzde", deger: "20" });
    expect(res.headers.get("location")).toBe("/admin/kodlar?hata=taken");
    expect(fakeStripe.coupons.size).toBe(1);
    expect(await (await req("/admin/kodlar?hata=taken")).text()).toContain("Bu kod zaten var");
  });

  it("invalid input never reaches Stripe", async () => {
    const res = await form("/admin/kodlar/yeni", { kod: "x", tur: "yuzde", deger: "10" });
    expect(res.headers.get("location")).toBe("/admin/kodlar?hata=code");
    expect(fakeStripe.coupons.size).toBe(0);
  });

  it("rejects cross-site posts (CSRF)", async () => {
    const res = await req("/admin/kodlar/yeni", {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" },
      body: "tur=yuzde&deger=100",
    });
    expect(res.status).toBe(403);
    expect(fakeStripe.coupons.size).toBe(0);
  });
});

describe("sending a code from a conversation", () => {
  it("emails the code with the right links through the admin flow", async () => {
    const conv = await newConversation("kod@example.com");
    await form("/admin/kodlar/yeni", { kod: "HOSGELDIN", tur: "yuzde", deger: "50", urun: "ikisi", son: "2027-01-31" });
    const page = await (await req(`/admin/konusma/${conv.id}`)).text();
    expect(page).toContain("HOSGELDIN — %50 indirim · Rehber ve Durum Analizi");
    fake.reset();

    const res = await form(`/admin/konusma/${conv.id}/kod`, { kod: lastPromo().id });
    expect(res.headers.get("location")).toBe(`/admin/konusma/${conv.id}?kod=1#kod`);
    const mail = fake.sent.at(-1)!;
    expect(mail.to).toEqual(["dev@example.com"]); // DEV_EMAIL guard
    expect(mail.text).toContain("kod@example.com"); // intended recipient noted
    expect(mail.text).toContain("Rehber ve Durum Analizi için indirim kodun: HOSGELDIN");
    expect(mail.text).toContain("%50 indirim. 31 Oca 2027 tarihine kadar geçerli.");
    expect(mail.text).toContain(`Rehber: ${env.APP_URL}/rehber`);
    expect(mail.text).toContain(`Durum Analizi: ${env.APP_URL}/konusma/${conv.reply_token}/odeme`);
    expect((await messages(conv.id)).at(-1)).toMatchObject({ direction: "out", via: "admin" });
  });

  it("refuses inactive or foreign codes", async () => {
    const conv = await newConversation("kod2@example.com");
    await form("/admin/kodlar/yeni", { kod: "ESKI", tur: "yuzde", deger: "10" });
    const id = lastPromo().id;
    await form(`/admin/kodlar/${id}/kapat`, {});
    expect((await form(`/admin/konusma/${conv.id}/kod`, { kod: id })).status).toBe(409);
    expect((await form(`/admin/konusma/${conv.id}/kod`, { kod: "promo_nope" })).status).toBe(409);
    expect((await form(`/admin/konusma/${conv.id}/kod`, { kod: "<script>" })).status).toBe(400);
  });

  it("promoBody: single-product codes link only that product", () => {
    const base = { id: "promo_1", code: "X1Y2", active: true, label: "%10 indirim", timesRedeemed: 0, maxRedemptions: null, expiresAt: null, createdBy: "gizem" };
    const guide = promoBody({ name: null, promo: { ...base, product: "guide" }, guideUrl: "G", paymentUrl: "P", expires: null });
    expect(guide).toContain("Rehber: G");
    expect(guide).not.toContain("Durum Analizi: P");
    expect(guide).toContain("%10 indirim.\n");
    const consult = promoBody({ name: "Ayşe", promo: { ...base, product: "consult" }, guideUrl: "G", paymentUrl: "P", expires: null });
    expect(consult).toMatch(/^Merhaba Ayşe,/);
    expect(consult).toContain("Durum Analizi: P");
    expect(consult).not.toContain("Rehber: G");
  });
});
