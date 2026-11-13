import { DateTime } from "luxon";
import { stripeCall } from "./stripe";

/**
 * Discount codes (Phase P). Stripe is the source of truth: a coupon (the discount) plus a
 * promotion code (what the customer types at Checkout). Nothing is stored in D1; codes
 * are listed from Stripe by `metadata.project = "uceksen"`.
 */

export type PromoProduct = "guide" | "consult" | "both";
export type PromoKind = "percent" | "amount";

export const PROMO = {
  code: /^[A-Z0-9]{4,20}$/,
  maxAmountEur: 200,
  maxRedemptions: 1000,
} as const;

export const PRODUCT_LABEL: Record<PromoProduct, string> = { guide: "Rehber", consult: "Durum Analizi", both: "Rehber ve Durum Analizi" };

type PromoEnv = Pick<Env, "STRIPE_SECRET_KEY" | "STRIPE_PRODUCT_GUIDE" | "STRIPE_PRODUCT_CONSULT">;

export type PromoInput = {
  code?: string;
  kind: PromoKind;
  value: number; // percent 1–100, or whole euros
  product: PromoProduct;
  expiresAt?: string | null; // ISO UTC
  maxRedemptions?: number | null;
  createdBy: string;
};

export type Promo = {
  id: string;
  code: string;
  active: boolean;
  label: string;
  product: PromoProduct;
  timesRedeemed: number;
  maxRedemptions: number | null;
  expiresAt: string | null;
  createdBy: string | null;
};

/** "%100 indirim" / "€20 indirim" — also the coupon name shown at Checkout. */
export function discountLabel(kind: PromoKind, value: number): string {
  return kind === "percent" ? `%${value} indirim` : `€${value} indirim`;
}

/** Unambiguous letters and digits only (no 0/O, 1/I/L). */
export function generateCode(len = 8): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}

export type PromoError = "code" | "value" | "max" | "expiry" | "taken" | "stripe";

/** Validates admin input; returns the normalised input or an error key. */
export function parsePromoForm(
  body: Record<string, unknown>,
  hostTz: string,
  now: DateTime = DateTime.utc(),
): { ok: true; input: Omit<PromoInput, "createdBy"> } | { ok: false; error: PromoError } {
  const s = (k: string) => (typeof body[k] === "string" ? (body[k] as string).trim() : "");
  const code = s("kod").toUpperCase();
  if (code && !PROMO.code.test(code)) return { ok: false, error: "code" };
  const kind: PromoKind = s("tur") === "tutar" ? "amount" : "percent";
  const value = Number(s("deger"));
  const maxValue = kind === "percent" ? 100 : PROMO.maxAmountEur;
  if (!Number.isInteger(value) || value < 1 || value > maxValue) return { ok: false, error: "value" };
  const product: PromoProduct = s("urun") === "danismanlik" ? "consult" : s("urun") === "ikisi" ? "both" : "guide";
  let maxRedemptions: number | null = null;
  if (s("limit")) {
    maxRedemptions = Number(s("limit"));
    if (!Number.isInteger(maxRedemptions) || maxRedemptions < 1 || maxRedemptions > PROMO.maxRedemptions) return { ok: false, error: "max" };
  }
  let expiresAt: string | null = null;
  if (s("son")) {
    // Valid through the end of that day in the host's time zone.
    const end = DateTime.fromISO(s("son"), { zone: hostTz }).endOf("day");
    if (!end.isValid || end <= now) return { ok: false, error: "expiry" };
    expiresAt = end.toUTC().toISO()!;
  }
  return { ok: true, input: { code: code || undefined, kind, value, product, expiresAt, maxRedemptions } };
}

type StripeCoupon = { id: string };
type StripePromotionCode = {
  id: string;
  code: string;
  active: boolean;
  times_redeemed: number;
  max_redemptions: number | null;
  expires_at: number | null;
  metadata: Record<string, string> | null;
};

function productIds(env: PromoEnv, p: PromoProduct): string[] {
  return p === "guide" ? [env.STRIPE_PRODUCT_GUIDE] : p === "consult" ? [env.STRIPE_PRODUCT_CONSULT] : [env.STRIPE_PRODUCT_GUIDE, env.STRIPE_PRODUCT_CONSULT];
}

function toPromo(p: StripePromotionCode): Promo {
  const m = p.metadata ?? {};
  return {
    id: p.id,
    code: p.code,
    active: p.active,
    label: m.label ?? "",
    product: (m.product as PromoProduct) ?? "guide",
    timesRedeemed: p.times_redeemed,
    maxRedemptions: p.max_redemptions,
    expiresAt: p.expires_at ? DateTime.fromSeconds(p.expires_at, { zone: "utc" }).toISO() : null,
    createdBy: m.created_by ?? null,
  };
}

/** Creates the coupon and its promotion code. Throws "taken" when the code already exists. */
export async function createPromo(env: PromoEnv, input: PromoInput): Promise<Promo> {
  const label = discountLabel(input.kind, input.value);
  const meta = { project: "uceksen", product: input.product, label, created_by: input.createdBy };
  const coupon = await stripeCall<StripeCoupon>(env, "POST", "/coupons", {
    duration: "once",
    name: label,
    ...(input.kind === "percent" ? { percent_off: input.value } : { amount_off: input.value * 100, currency: "eur" }),
    applies_to: { products: productIds(env, input.product) },
    metadata: meta,
  });
  try {
    const promo = await stripeCall<StripePromotionCode>(env, "POST", "/promotion_codes", {
      promotion: { type: "coupon", coupon: coupon.id },
      code: input.code ?? generateCode(),
      max_redemptions: input.maxRedemptions ?? undefined,
      expires_at: input.expiresAt ? Math.floor(DateTime.fromISO(input.expiresAt).toSeconds()) : undefined,
      metadata: meta,
    });
    return toPromo(promo);
  } catch (err) {
    // Don't leave an orphaned coupon behind.
    await stripeCall(env, "DELETE", `/coupons/${encodeURIComponent(coupon.id)}`).catch(() => {});
    if (String(err).includes("already exists")) throw new PromoTakenError();
    throw err;
  }
}

export class PromoTakenError extends Error {}

/** Active codes of this project, newest first. */
export async function listPromos(env: PromoEnv): Promise<Promo[]> {
  const res = await stripeCall<{ data: StripePromotionCode[] }>(env, "GET", "/promotion_codes?active=true&limit=100");
  return res.data.filter((p) => p.metadata?.project === "uceksen").map(toPromo);
}

export async function getPromo(env: PromoEnv, id: string): Promise<Promo | null> {
  const p = await stripeCall<StripePromotionCode>(env, "GET", `/promotion_codes/${encodeURIComponent(id)}`).catch(() => null);
  return p && p.metadata?.project === "uceksen" ? toPromo(p) : null;
}

export async function deactivatePromo(env: PromoEnv, id: string): Promise<void> {
  await stripeCall(env, "POST", `/promotion_codes/${encodeURIComponent(id)}`, { active: false });
}

/** Email text for sending a code to a customer from their conversation. */
export function promoBody(p: {
  name: string | null;
  promo: Promo;
  guideUrl: string;
  paymentUrl: string;
  expires: string | null;
}): string {
  const where = [
    ...(p.promo.product !== "consult" ? [`Rehber: ${p.guideUrl}`] : []),
    ...(p.promo.product !== "guide" ? [`Durum Analizi: ${p.paymentUrl}`] : []),
  ];
  return [
    p.name ? `Merhaba ${p.name},` : "Merhaba,",
    "",
    `${PRODUCT_LABEL[p.promo.product]} için indirim kodun: ${p.promo.code}`,
    `${p.promo.label[0]!.toUpperCase()}${p.promo.label.slice(1)}.${p.expires ? ` ${p.expires} tarihine kadar geçerli.` : ""}`,
    "",
    "Ödeme sayfasında “Promosyon kodu ekle”ye tıklayıp kodu gir.",
    ...where,
  ].join("\n");
}
