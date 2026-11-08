import { DateTime } from "luxon";
import { conversationUrl, deliverMessage, notifyAdmins, sendOutgoing } from "./conversations";
import { retrieveInvoice, type CheckoutSession } from "./stripe";
import { nowIso } from "./time";
import { randomMailToken, randomToken } from "./tokens";

type GuideEnv = Pick<
  Env,
  | "DB" | "ENVIRONMENT" | "DEV_EMAIL" | "RESEND_API_KEY" | "MAIL_FROM" | "REPLY_LOCAL" | "REPLY_DOMAIN" | "APP_URL"
  | "ADMIN_EMAILS" | "STRIPE_SECRET_KEY"
>;

export const GUIDE = { tokenDays: 7, maxDownloads: 5, noticeBatch: 25 } as const;
export const PURCHASE_SUBJECT = "Rehber siparişin";

export type GuideVersion = { id: number; version: string; r2_key: string; size: number | null; created_at: string };

export async function currentGuide(db: D1Database): Promise<GuideVersion | null> {
  return db.prepare("SELECT id, version, r2_key, size, created_at FROM guide_versions WHERE is_current = 1").first<GuideVersion>();
}

export function downloadUrl(env: Pick<Env, "APP_URL">, token: string): string {
  return `${env.APP_URL}/d/${token}`;
}

export function formatEur(cents: number, currency = "eur"): string {
  return new Intl.NumberFormat("tr-TR", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);
}

const tokenExpiry = (from = DateTime.utc()) => from.plus({ days: GUIDE.tokenDays }).toISO()!;

const insertToken = (db: D1Database, token: string, purchaseRef: { id: number } | { session: string }, now: string) =>
  "id" in purchaseRef
    ? db.prepare("INSERT INTO download_tokens (token, purchase_id, expires_at, max_downloads, created_at) VALUES (?1, ?2, ?3, ?4, ?5)")
        .bind(token, purchaseRef.id, tokenExpiry(), GUIDE.maxDownloads, now)
    : db.prepare(
        `INSERT INTO download_tokens (token, purchase_id, expires_at, max_downloads, created_at)
         VALUES (?1, (SELECT id FROM purchases WHERE stripe_session_id = ?2), ?3, ?4, ?5)`,
      ).bind(token, purchaseRef.session, tokenExpiry(), GUIDE.maxDownloads, now);

const hello = (name: string | null) => (name ? `Merhaba ${name},` : "Merhaba,");
const LINK_RULES = `Bağlantı ${GUIDE.tokenDays} gün geçerli ve ${GUIDE.maxDownloads} kez kullanılabilir.`;

export function deliveryBody(env: Pick<Env, "APP_URL">, p: { name: string | null; token: string; amount: string; invoiceUrl: string | null }): string {
  return [
    hello(p.name),
    "",
    "Üç Eksen rehberini aldığın için teşekkürler.",
    "",
    "İndirme bağlantın:",
    downloadUrl(env, p.token),
    "",
    `${LINK_RULES} Süresi dolarsa ${env.APP_URL}/indir adresine satın alma e-postanı yazarak yeni bağlantı alabilirsin.`,
    "",
    `Ödenen: ${p.amount} (KDV dahil)`,
    p.invoiceUrl ? `Fatura: ${p.invoiceUrl}` : "Faturan ayrı bir e-postayla gelecek.",
    "",
    "Dosya açılmazsa ya da bir sorun olursa bu e-postayı yanıtlaman yeterli.",
  ].join("\n");
}

export function freshLinkBody(env: Pick<Env, "APP_URL">, name: string | null, token: string): string {
  return [hello(name), "", "Rehber için yeni indirme bağlantın:", downloadUrl(env, token), "", LINK_RULES].join("\n");
}

export function updateNoticeBody(env: Pick<Env, "APP_URL">, p: { name: string | null; version: string; token: string; replyToken: string }): string {
  return [
    hello(p.name),
    "",
    `Üç Eksen rehberinin yeni sürümü (${p.version}) hazır. Rehberi satın aldığın için bu sürüm de senin.`,
    "",
    "İndirme bağlantın:",
    downloadUrl(env, p.token),
    "",
    LINK_RULES,
    "",
    `Rehber güncellemeleriyle ilgili e-posta almak istemiyorsan: ${conversationUrl(env, p.replyToken)}/abonelik`,
  ].join("\n");
}

export type FulfillResult = "created" | "duplicate" | "ignored" | "unpaid";

/**
 * checkout.session.completed / async_payment_succeeded for the guide. Idempotent:
 * Stripe retries webhooks, and stripe_session_id is unique. Everything is written in
 * one transaction (contact, conversation, purchase, token, delivery message); the
 * delivery email is sent afterwards and, if it fails, is resent from /admin.
 */
export async function fulfillGuide(env: GuideEnv, s: CheckoutSession): Promise<FulfillResult> {
  if (s.metadata?.project !== "uceksen" || s.metadata?.kind !== "guide" || s.mode !== "payment") return "ignored";
  if (s.payment_status !== "paid") return "unpaid";
  const email = s.customer_details?.email?.trim().toLowerCase();
  if (!email) throw new Error(`checkout session ${s.id} has no customer email`);

  const existing = await env.DB.prepare("SELECT conversation_id FROM purchases WHERE stripe_session_id = ?1").bind(s.id).first<{ conversation_id: number | null }>();
  if (existing) {
    await deliverPending(env, existing.conversation_id);
    return "duplicate";
  }

  let invoiceUrl: string | null = null;
  if (s.invoice) invoiceUrl = await retrieveInvoice(env, s.invoice).then((i) => i.hosted_invoice_url, () => null);

  const now = nowIso();
  const name = s.customer_details?.name?.trim() || null;
  const token = randomToken();
  const replyToken = randomToken();
  const amount = s.amount_total ?? 0;
  const currency = s.currency ?? "eur";
  const db = env.DB;
  try {
    await db.batch([
      db.prepare(
        `INSERT INTO contacts (email, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)
         ON CONFLICT(email) DO UPDATE SET name = COALESCE(contacts.name, excluded.name), updated_at = excluded.updated_at`,
      ).bind(email, name, now),
      db.prepare(
        `INSERT INTO conversations (contact_id, subject, state, reply_token, plus_token, last_message_at, created_at, source)
         VALUES ((SELECT id FROM contacts WHERE email = ?1), ?2, 'completed', ?3, ?4, ?5, ?5, 'rehber')`,
      ).bind(email, PURCHASE_SUBJECT, replyToken, randomMailToken(), now),
      db.prepare(
        `INSERT INTO purchases (contact_id, stripe_session_id, stripe_payment_intent, amount_cents, currency, country,
                                conversation_id, stripe_invoice_id, invoice_url, terms_accepted, created_at)
         VALUES ((SELECT id FROM contacts WHERE email = ?1), ?2, ?3, ?4, ?5, ?6,
                 (SELECT id FROM conversations WHERE reply_token = ?7), ?8, ?9, ?10, ?11)`,
      ).bind(
        email, s.id, s.payment_intent, amount, currency, s.customer_details?.address?.country ?? null,
        replyToken, s.invoice, invoiceUrl, s.consent?.terms_of_service === "accepted" ? 1 : 0, now,
      ),
      insertToken(db, token, { session: s.id }, now),
      db.prepare(
        `INSERT INTO messages (conversation_id, direction, body_text, author, created_at, send_status, via)
         VALUES ((SELECT id FROM conversations WHERE reply_token = ?1), 'out', ?2, 'system', ?3, 'pending', 'system')`,
      ).bind(replyToken, deliveryBody(env, { name: name ?? null, token, amount: formatEur(amount, currency), invoiceUrl }), now),
    ]);
  } catch (err) {
    // Two deliveries of the same event racing each other: the other one won.
    if (String(err).includes("UNIQUE") && (await db.prepare("SELECT 1 FROM purchases WHERE stripe_session_id = ?1").bind(s.id).first())) {
      return "duplicate";
    }
    throw err;
  }

  const conv = await db.prepare("SELECT id FROM conversations WHERE reply_token = ?1").bind(replyToken).first<{ id: number }>();
  await deliverPending(env, conv!.id);
  await notifyAdmins(env, `Yeni satış: ${name ?? email}`, [
    "Rehber satıldı.",
    "",
    name ? `${name} <${email}>` : email,
    `Tutar: ${formatEur(amount, currency)} · Ülke: ${s.customer_details?.address?.country ?? "—"}`,
    "",
    `Aç: ${env.APP_URL}/admin/konusma/${conv!.id}`,
  ]);
  return "created";
}

/** Sends any outgoing message of the conversation still waiting to go out. */
async function deliverPending(env: GuideEnv, convId: number | null): Promise<void> {
  if (!convId) return;
  const rows = await env.DB.prepare(
    "SELECT id FROM messages WHERE conversation_id = ?1 AND direction = 'out' AND send_status = 'pending' ORDER BY id",
  ).bind(convId).all<{ id: number }>();
  for (const r of rows.results) await deliverMessage(env, r.id);
}

type LatestPurchase = { purchase_id: number; conversation_id: number; name: string | null; reply_token: string; contact_id: number };

const LATEST_PURCHASE = `
  SELECT p.id AS purchase_id, p.conversation_id, ct.name, c.reply_token, ct.id AS contact_id
    FROM purchases p JOIN contacts ct ON ct.id = p.contact_id JOIN conversations c ON c.id = p.conversation_id`;

/** /indir: a fresh token for the latest purchase of this email. False if there is none. */
export async function sendFreshLink(env: GuideEnv, email: string): Promise<boolean> {
  const p = await env.DB.prepare(`${LATEST_PURCHASE} WHERE ct.email = ?1 ORDER BY p.id DESC LIMIT 1`)
    .bind(email.trim().toLowerCase())
    .first<LatestPurchase>();
  if (!p) return false;
  const token = randomToken();
  await insertToken(env.DB, token, { id: p.purchase_id }, nowIso()).run();
  await sendOutgoing(env, p.conversation_id, "system", freshLinkBody(env, p.name, token), { via: "system" });
  return true;
}

export async function pendingNoticeCount(db: D1Database, versionId: number): Promise<number> {
  const r = await db.prepare(
    `SELECT COUNT(*) AS n FROM contacts ct
      WHERE ct.guide_updates_optout_at IS NULL
        AND EXISTS (SELECT 1 FROM purchases p WHERE p.contact_id = ct.id AND p.conversation_id IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM guide_update_notices n WHERE n.contact_id = ct.id AND n.guide_version_id = ?1)`,
  ).bind(versionId).first<{ n: number }>();
  return r?.n ?? 0;
}

/**
 * Tells purchasers about a new guide version, one batch per call (subrequest limits),
 * each person once per version, skipping those who opted out.
 */
export async function notifyPurchasers(env: GuideEnv, versionId: number): Promise<{ sent: number; failed: number; remaining: number }> {
  const v = await env.DB.prepare("SELECT version FROM guide_versions WHERE id = ?1").bind(versionId).first<{ version: string }>();
  if (!v) throw new Error(`guide version ${versionId} not found`);
  const rows = await env.DB.prepare(
    `${LATEST_PURCHASE}
      WHERE p.id = (SELECT MAX(p2.id) FROM purchases p2 WHERE p2.contact_id = ct.id AND p2.conversation_id IS NOT NULL)
        AND ct.guide_updates_optout_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM guide_update_notices n WHERE n.contact_id = ct.id AND n.guide_version_id = ?1)
      ORDER BY p.id LIMIT ?2`,
  ).bind(versionId, GUIDE.noticeBatch).all<LatestPurchase>();
  let sent = 0;
  let failed = 0;
  for (const p of rows.results) {
    // Claim first, so a double click or a parallel run never emails anyone twice.
    const claim = await env.DB.prepare("INSERT OR IGNORE INTO guide_update_notices (guide_version_id, contact_id) VALUES (?1, ?2)")
      .bind(versionId, p.contact_id).run();
    if (!claim.meta.changes) continue;
    const token = randomToken();
    await insertToken(env.DB, token, { id: p.purchase_id }, nowIso()).run();
    const r = await sendOutgoing(env, p.conversation_id, "system", updateNoticeBody(env, { name: p.name, version: v.version, token, replyToken: p.reply_token }), { via: "system" });
    if (r.sent) sent++;
    else failed++;
  }
  return { sent, failed, remaining: await pendingNoticeCount(env.DB, versionId) };
}

export type TokenState =
  | { ok: true; tokenId: number; remaining: number; expiresAt: string }
  | { ok: false; reason: "unknown" | "expired" | "used_up" };

export async function checkToken(db: D1Database, token: string): Promise<TokenState> {
  const t = await db.prepare("SELECT id, expires_at, max_downloads, download_count FROM download_tokens WHERE token = ?1")
    .bind(token)
    .first<{ id: number; expires_at: string; max_downloads: number; download_count: number }>();
  if (!t) return { ok: false, reason: "unknown" };
  if (t.expires_at <= nowIso()) return { ok: false, reason: "expired" };
  if (t.download_count >= t.max_downloads) return { ok: false, reason: "used_up" };
  return { ok: true, tokenId: t.id, remaining: t.max_downloads - t.download_count, expiresAt: t.expires_at };
}

/** Counts one download, atomically: two parallel clicks on the last download cannot both pass. */
export async function consumeToken(db: D1Database, token: string): Promise<boolean> {
  const r = await db.prepare(
    `UPDATE download_tokens SET download_count = download_count + 1
      WHERE token = ?1 AND download_count < max_downloads AND expires_at > ?2`,
  ).bind(token, nowIso()).run();
  return r.meta.changes === 1;
}
