import { stripeApi } from "../src/lib/stripe";

/** In-memory stand-in for the Stripe API. Installed for every test file (see vitest.config.ts). */
export const fakeStripe = {
  sessions: [] as URLSearchParams[],
  invoices: new Map<string, { id: string; hosted_invoice_url: string | null; number: string | null }>(),
  /** Sessions returned by GET /v1/checkout/sessions/:id. */
  stored: new Map<string, unknown>(),
  refunds: [] as { payment_intent: string; idempotencyKey: string | null }[],
  failRefunds: false,
  fail: false,
  seq: 0,
  coupons: new Map<string, Record<string, string>>(),
  promos: new Map<string, { id: string; code: string; active: boolean; times_redeemed: number; max_redemptions: number | null; expires_at: number | null; metadata: Record<string, string>; coupon: string }>(),
  reset() {
    this.coupons.clear();
    this.promos.clear();
    this.sessions = [];
    this.invoices.clear();
    this.stored.clear();
    this.refunds = [];
    this.failRefunds = false;
    this.fail = false;
  },
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

stripeApi.fetch = async (url: string, init?: RequestInit) => {
  const u = new URL(url);
  if (u.hostname !== "api.stripe.com") throw new Error(`unexpected fetch ${url}`);
  if (fakeStripe.fail) return json({ error: { message: "boom" } }, 500);
  if (init?.method === "POST" && u.pathname === "/v1/checkout/sessions") {
    const params = new URLSearchParams(String(init.body));
    fakeStripe.sessions.push(params);
    const id = `cs_test_${++fakeStripe.seq}`;
    return json({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
  }
  if (init?.method === "POST" && u.pathname === "/v1/refunds") {
    if (fakeStripe.failRefunds) return json({ error: { message: "charge already refunded" } }, 400);
    const params = new URLSearchParams(String(init.body));
    const key = new Headers(init.headers).get("idempotency-key");
    fakeStripe.refunds.push({ payment_intent: params.get("payment_intent")!, idempotencyKey: key });
    return json({ id: `re_${++fakeStripe.seq}`, status: "succeeded" });
  }
  // Coupons and promotion codes (Phase P), in the 2026 API shape: promotion[type]=coupon.
  const meta = (p: URLSearchParams) => Object.fromEntries([...p].filter(([k]) => k.startsWith("metadata[")).map(([k, v]) => [k.slice(9, -1), v]));
  if (init?.method === "POST" && u.pathname === "/v1/coupons") {
    const p = new URLSearchParams(String(init.body));
    const id = `cp_${++fakeStripe.seq}`;
    fakeStripe.coupons.set(id, Object.fromEntries(p));
    return json({ id });
  }
  const cd = u.pathname.match(/^\/v1\/coupons\/([^/]+)$/);
  if (init?.method === "DELETE" && cd) {
    fakeStripe.coupons.delete(decodeURIComponent(cd[1]!));
    return json({ id: cd[1], deleted: true });
  }
  if (init?.method === "POST" && u.pathname === "/v1/promotion_codes") {
    const p = new URLSearchParams(String(init.body));
    if (p.has("coupon")) return json({ error: { message: "Received unknown parameter: coupon" } }, 400);
    const code = p.get("code")!;
    if ([...fakeStripe.promos.values()].some((x) => x.code === code && x.active)) {
      return json({ error: { message: "An active promotion code with `code: " + code + "` already exists." } }, 400);
    }
    const id = `promo_${++fakeStripe.seq}`;
    const promo = {
      id, code, active: true, times_redeemed: 0, coupon: p.get("promotion[coupon]")!,
      max_redemptions: p.get("max_redemptions") ? Number(p.get("max_redemptions")) : null,
      expires_at: p.get("expires_at") ? Number(p.get("expires_at")) : null,
      metadata: meta(p),
    };
    fakeStripe.promos.set(id, promo);
    return json(promo);
  }
  if (u.pathname === "/v1/promotion_codes" && (init?.method ?? "GET") === "GET") {
    const active = u.searchParams.get("active");
    return json({ data: [...fakeStripe.promos.values()].filter((x) => active !== "true" || x.active).reverse() });
  }
  const pc = u.pathname.match(/^\/v1\/promotion_codes\/([^/]+)$/);
  if (pc) {
    const promo = fakeStripe.promos.get(decodeURIComponent(pc[1]!));
    if (!promo) return json({ error: { message: "no such promotion code" } }, 404);
    if (init?.method === "POST") promo.active = new URLSearchParams(String(init.body)).get("active") !== "false";
    return json(promo);
  }
  const cs = u.pathname.match(/^\/v1\/checkout\/sessions\/([^/]+)$/);
  if (cs) {
    const s = fakeStripe.stored.get(decodeURIComponent(cs[1]!));
    return s ? json(s) : json({ error: { message: "no such session" } }, 404);
  }
  const m = u.pathname.match(/^\/v1\/invoices\/([^/]+)$/);
  if (m) {
    const inv = fakeStripe.invoices.get(decodeURIComponent(m[1]!));
    return inv ? json(inv) : json({ error: { message: "no such invoice" } }, 404);
  }
  throw new Error(`unexpected Stripe call ${init?.method ?? "GET"} ${u.pathname}`);
};
