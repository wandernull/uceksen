const API = "https://api.stripe.com/v1";

/** Overridable in tests. Every call to Stripe goes through here. */
export const stripeApi: { fetch: (url: string, init?: RequestInit) => Promise<Response> } = {
  fetch: (url, init) => fetch(url, init),
};

type Params = { [k: string]: string | number | boolean | null | undefined | Params | Params[] };

/** Stripe's form encoding: nested objects become a[b][c]=v. */
export function formEncode(params: Params, prefix = "", out = new URLSearchParams()): URLSearchParams {
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => formEncode(item, `${key}[${i}]`, out));
    else if (typeof v === "object") formEncode(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

async function call<T>(env: Pick<Env, "STRIPE_SECRET_KEY">, method: "GET" | "POST", path: string, params?: Params): Promise<T> {
  const res = await stripeApi.fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: method === "POST" && params ? formEncode(params).toString() : undefined,
  });
  if (!res.ok) throw new Error(`Stripe ${method} ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

/** Shown on every invoice: the legal entity behind the brand. */
export const INVOICE_FOOTER =
  "Back of the Envelope B.V. · Keizersgracht 520H, 1017EK Amsterdam · KvK 97838810 · BTW NL868254010B01";

/** Checkout look. Logo, icon and colours also come from the account branding (dashboard). */
const BRANDING = {
  display_name: "Üç Eksen",
  font_family: "source_sans_pro", // sister of Source Serif 4 (not offered); clear ₺ (PT Serif lacks it, Noto Serif draws it like "Ł")
  border_style: "rectangular",
  background_color: "#F4F4F1",
  button_color: "#3A5A40",
};

const TERMS_TEXT = (url: string) =>
  `[Satış koşullarını](${url}/satis-kosullari) kabul ediyorum. Rehberin hemen teslim edilmesini onaylıyor, bu nedenle cayma hakkımı kaybettiğimi kabul ediyorum.`;

export type CheckoutSession = {
  id: string;
  url: string | null;
  mode: string;
  status: string | null;
  payment_status: "paid" | "unpaid" | "no_payment_required";
  amount_total: number | null;
  currency: string | null;
  payment_intent: string | null;
  invoice: string | null;
  metadata: Record<string, string> | null;
  consent: { terms_of_service?: string | null } | null;
  customer_details: { email: string | null; name: string | null; address: { country: string | null } | null } | null;
  /** Set when Adaptive Pricing charged the customer in their local currency (amount_total/currency are then local). */
  currency_conversion?: { amount_total: number; source_currency: string; fx_rate: string } | null;
};

export async function createGuideCheckout(
  env: Pick<Env, "STRIPE_SECRET_KEY" | "STRIPE_PRICE_GUIDE" | "APP_URL">,
): Promise<CheckoutSession> {
  const meta = { project: "uceksen", kind: "guide" };
  return call<CheckoutSession>(env, "POST", "/checkout/sessions", {
    mode: "payment",
    line_items: [{ price: env.STRIPE_PRICE_GUIDE, quantity: 1 }],
    automatic_tax: { enabled: true },
    // In the EU the withdrawal-right waiver for digital content needs this explicit consent.
    consent_collection: { terms_of_service: "required" },
    custom_text: { terms_of_service_acceptance: { message: TERMS_TEXT(env.APP_URL) } },
    invoice_creation: { enabled: true, invoice_data: { footer: INVOICE_FOOTER, metadata: meta } },
    payment_intent_data: { metadata: meta },
    metadata: meta,
    locale: "tr",
    branding_settings: BRANDING,
    success_url: `${env.APP_URL}/rehber/tesekkurler`,
    cancel_url: `${env.APP_URL}/rehber`,
  });
}

export async function retrieveInvoice(
  env: Pick<Env, "STRIPE_SECRET_KEY">,
  id: string,
): Promise<{ id: string; hosted_invoice_url: string | null; number: string | null }> {
  return call(env, "GET", `/invoices/${encodeURIComponent(id)}`);
}

// --- Webhook signatures -------------------------------------------------------------
// Stripe-Signature: "t=<unix>,v1=<hex>[,v1=<hex>...]"
// v1 = hex(HMAC-SHA256(key = the whole "whsec_..." string, `${t}.${raw body}`))

export const STRIPE_TOLERANCE_SEC = 5 * 60;

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signStripe(secret: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`)));
}

export async function verifyStripeSignature(
  secret: string | undefined,
  header: string | undefined,
  body: string,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!secret || !header) return false;
  const parts = header.split(",").map((p) => p.trim().split("="));
  const t = parts.find(([k]) => k === "t")?.[1];
  const sigs = parts.filter(([k, v]) => k === "v1" && v).map(([, v]) => v!);
  if (!t || !/^\d+$/.test(t) || !sigs.length) return false;
  if (Math.abs(nowSec - Number(t)) > STRIPE_TOLERANCE_SEC) return false;
  const expected = await signStripe(secret, t, body);
  return sigs.some((s) => timingSafeEqual(s, expected));
}
