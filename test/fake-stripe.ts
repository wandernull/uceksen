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
  reset() {
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
