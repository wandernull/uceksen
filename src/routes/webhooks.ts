import { Hono } from "hono";
import type { AppEnv } from "../env";
import { ATTACH, storeAttachment } from "../lib/attachments";
import { notifyAdmins, notifyNewMessage, recordIncoming, snippet } from "../lib/conversations";
import { extractPlusToken, htmlToText, parseAddress, parseMessageIds, stripQuotes } from "../lib/inbound";
import { fetchReceivedAttachments, fetchReceivedEmail, fetchSentMessageId, resendApi, type ReceivedEmail } from "../lib/mail";
import { fulfillGuide } from "../lib/guide";
import { verifyStripeSignature, type CheckoutSession } from "../lib/stripe";
import { verifyWebhook } from "../lib/webhook-signature";

export const webhooks = new Hono<AppEnv>();

const MAX_BODY = 100_000;

/** Conversation for an inbound email: In-Reply-To/References first, then the plus token. */
export async function matchConversation(
  env: Pick<Env, "DB" | "REPLY_LOCAL" | "REPLY_DOMAIN" | "RESEND_API_KEY">,
  email: ReceivedEmail,
): Promise<number | null> {
  const h = email.headers ?? {};
  const ids = [...parseMessageIds(h["in-reply-to"]), ...parseMessageIds(h["references"])];
  if (ids.length) {
    const byHeader = () =>
      env.DB.prepare(
        `SELECT conversation_id FROM messages WHERE provider_message_id IN (${ids.map((_, i) => `?${i + 1}`).join(",")})
          ORDER BY id DESC LIMIT 1`,
      )
        .bind(...ids)
        .first<{ conversation_id: number }>();
    let row = await byHeader();
    if (!row && (await resolvePendingMessageIds(env))) row = await byHeader();
    if (row) return row.conversation_id;
  }
  const token = extractPlusToken(
    [...(email.to ?? []), ...(email.received_for ?? []), ...(email.cc ?? []), h["to"], h["delivered-to"]],
    env.REPLY_LOCAL,
    env.REPLY_DOMAIN,
  );
  if (!token) return null;
  const conv = await env.DB.prepare("SELECT id FROM conversations WHERE plus_token = ?1").bind(token).first<{ id: number }>();
  return conv?.id ?? null;
}

/**
 * SES assigns the Message-ID after Resend accepts a send, so it is often unknown right
 * after sending. Before giving up on header matching, look up the recent unknown ones.
 */
async function resolvePendingMessageIds(env: Pick<Env, "DB" | "RESEND_API_KEY">): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT id, resend_id FROM messages WHERE direction = 'out' AND resend_id IS NOT NULL AND provider_message_id IS NULL
      ORDER BY id DESC LIMIT 20`,
  ).all<{ id: number; resend_id: string }>();
  let found = 0;
  for (const r of rows.results) {
    const mid = await fetchSentMessageId(env, r.resend_id).catch(() => null);
    if (!mid) continue;
    await env.DB.prepare("UPDATE messages SET provider_message_id = ?1 WHERE id = ?2").bind(mid, r.id).run();
    found++;
  }
  return found;
}

export function cleanBody(email: Pick<ReceivedEmail, "text" | "html">): { text: string; raw: string } {
  const raw = (email.text ?? (email.html ? htmlToText(email.html) : "")).slice(0, MAX_BODY);
  return { text: stripQuotes(raw), raw };
}

webhooks.post("/resend", async (c) => {
  const body = await c.req.text();
  const ok = await verifyWebhook(
    c.env.RESEND_INBOUND_SECRET,
    { id: c.req.header("svix-id"), timestamp: c.req.header("svix-timestamp"), signature: c.req.header("svix-signature") },
    body,
  );
  if (!ok) return c.json({ ok: false }, 401);

  let event: { type?: string; data?: { email_id?: string } };
  try {
    event = JSON.parse(body);
  } catch {
    return c.json({ ok: false }, 400);
  }
  if (event.type !== "email.received" || !event.data?.email_id) return c.json({ ok: true, ignored: true });

  // Errors from here on return 500 so Resend retries the delivery.
  const email = await fetchReceivedEmail(c.env, event.data.email_id);
  const providerId = email.message_id ?? email.headers?.["message-id"] ?? null;

  if (providerId) {
    const dup = await c.env.DB.prepare(
      `SELECT 1 FROM messages WHERE direction = 'in' AND provider_message_id = ?1
       UNION ALL SELECT 1 FROM unmatched_emails WHERE provider_message_id = ?1 LIMIT 1`,
    )
      .bind(providerId)
      .first();
    if (dup) return c.json({ ok: true, duplicate: true });
  }

  const from = parseAddress(email.from)?.email ?? email.from ?? null;
  const { text, raw } = cleanBody(email);
  const convId = await matchConversation(c.env, email);

  if (convId === null) {
    // Keep everything except the short-lived signed download URL of the raw MIME.
    const { raw: _signedUrl, ...stored } = email as ReceivedEmail & { raw?: unknown };
    await c.env.DB.prepare(
      `INSERT INTO unmatched_emails (from_addr, to_addr, subject, body_text, raw_json, provider_message_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
      .bind(from, (email.to ?? []).join(", "), email.subject, text, JSON.stringify({ ...stored, raw_text: raw }), providerId)
      .run();
    await notifyAdmins(c.env, `Eşleşmeyen e-posta: ${from ?? "?"}`, [
      "Hiçbir konuşmaya bağlanamayan bir e-posta geldi.",
      "",
      `Kimden: ${email.from}`,
      `Kime: ${(email.to ?? []).join(", ")}`,
      `Konu: ${email.subject ?? "—"}`,
      "",
      snippet(text),
      "",
      `Aç: ${c.env.APP_URL}/admin/eslesmeyen`,
    ]);
    return c.json({ ok: true, matched: false });
  }

  const messageId = await recordIncoming(c.env, { convId, text, raw, via: "email", fromAddr: from, providerMessageId: providerId });

  if (email.attachments?.length) {
    const list = await fetchReceivedAttachments(c.env, email.id).catch((err) => {
      console.error("inbound attachment list failed", email.id, err);
      return [];
    });
    // The message is already stored, so a failed attachment is logged, not retried
    // (a retry would be dropped as a duplicate). The raw email stays in Resend.
    for (const a of list.slice(0, ATTACH.maxFiles * 2)) {
      if (a.size > ATTACH.maxBytes) continue;
      try {
        const res = await resendApi.fetch(a.download_url);
        if (!res.ok) throw new Error(`download ${res.status}`);
        await storeAttachment(c.env, { convId, messageId, filename: a.filename, contentType: a.content_type, body: await res.arrayBuffer(), size: a.size });
      } catch (err) {
        console.error("inbound attachment failed", email.id, a.filename, err);
      }
    }
  }

  await notifyNewMessage(c.env, convId, "Yeni yanıt (e-posta)", text);
  return c.json({ ok: true, matched: true });
});

// --- Stripe ---------------------------------------------------------------------

const FULFIL_EVENTS = new Set(["checkout.session.completed", "checkout.session.async_payment_succeeded"]);

webhooks.post("/stripe", async (c) => {
  const body = await c.req.text();
  if (!(await verifyStripeSignature(c.env.STRIPE_WEBHOOK_SECRET, c.req.header("stripe-signature"), body))) {
    return c.json({ ok: false }, 401);
  }
  let event: { type?: string; data?: { object?: CheckoutSession } };
  try {
    event = JSON.parse(body);
  } catch {
    return c.json({ ok: false }, 400);
  }
  // Unknown event types are acknowledged and ignored (SPEC §5.6).
  if (!event.type || !FULFIL_EVENTS.has(event.type) || !event.data?.object) return c.json({ ok: true, ignored: true });
  // Errors throw → 500 → Stripe retries; fulfilment is idempotent per session.
  const result = await fulfillGuide(c.env, event.data.object);
  return c.json({ ok: true, result });
});
