import type { Author } from "../env";
import { parseAdmins } from "./admins";
import { fetchSentMessageId, sendMail } from "./mail";
import { nowIso } from "./time";

type MailEnv = Pick<
  Env,
  "DB" | "ENVIRONMENT" | "DEV_EMAIL" | "RESEND_API_KEY" | "MAIL_FROM" | "REPLY_LOCAL" | "REPLY_DOMAIN" | "APP_URL" | "ADMIN_EMAILS"
>;

export const AUTHOR_NAME: Record<Author, string> = { gizem: "Gizem", baran: "Baran" };

/** References header: the last few Message-IDs are enough for every client to thread. */
const MAX_REFERENCES = 10;

export function replyAddress(env: Pick<Env, "REPLY_LOCAL" | "REPLY_DOMAIN">, plusToken: string): string {
  return `${env.REPLY_LOCAL}+${plusToken}@${env.REPLY_DOMAIN}`;
}

export function conversationUrl(env: Pick<Env, "APP_URL">, replyToken: string): string {
  return `${env.APP_URL}/konusma/${replyToken}`;
}

export function quoteLines(text: string): string {
  return text.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n");
}

type ConvRow = {
  id: number; subject: string | null; reply_token: string; plus_token: string; email: string; name: string | null;
};

async function loadConversation(db: D1Database, id: number): Promise<ConvRow | null> {
  return db
    .prepare(
      `SELECT c.id, c.subject, c.reply_token, c.plus_token, ct.email, ct.name
         FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE c.id = ?1`,
    )
    .bind(id)
    .first<ConvRow>();
}

/**
 * Message-IDs of the conversation so far, oldest first. Outgoing rows whose
 * Message-ID is not known yet are resolved from Resend on the way.
 */
async function threadIds(env: MailEnv, convId: number, excludeId: number): Promise<string[]> {
  const rows = await env.DB.prepare(
    `SELECT id, provider_message_id, resend_id FROM messages
      WHERE conversation_id = ?1 AND id != ?2 AND (provider_message_id IS NOT NULL OR resend_id IS NOT NULL)
      ORDER BY created_at, id`,
  )
    .bind(convId, excludeId)
    .all<{ id: number; provider_message_id: string | null; resend_id: string | null }>();
  const ids: string[] = [];
  for (const r of rows.results) {
    let mid = r.provider_message_id;
    if (!mid && r.resend_id) {
      mid = await fetchSentMessageId(env, r.resend_id).catch(() => null);
      if (mid) await env.DB.prepare("UPDATE messages SET provider_message_id = ?1 WHERE id = ?2").bind(mid, r.id).run();
    }
    if (mid) ids.push(mid);
  }
  return ids;
}

const FOOTER = (url: string) => `\n\n—\nKonuşmanın tamamı ve dosya eklemek için: ${url}`;

function emailText(author: string, body: string, url: string): string {
  if (author === "system") return `${body}\n\nÜç Eksen${FOOTER(url)}`;
  const name = AUTHOR_NAME[author as Author] ?? "Üç Eksen";
  return `${body}\n\n${name}\nÜç Eksen${FOOTER(url)}`;
}

/**
 * Sends (or re-sends) one stored outgoing message to the conversation's contact.
 * The row is written before this is called; this only updates its send status.
 */
export async function deliverMessage(env: MailEnv, messageId: number): Promise<boolean> {
  const msg = await env.DB.prepare(
    "SELECT id, conversation_id, body_text, author FROM messages WHERE id = ?1 AND direction = 'out'",
  )
    .bind(messageId)
    .first<{ id: number; conversation_id: number; body_text: string | null; author: string }>();
  if (!msg) return false;
  const conv = await loadConversation(env.DB, msg.conversation_id);
  if (!conv) return false;

  try {
    const ids = await threadIds(env, conv.id, msg.id);
    const base = `${conv.subject ?? "Mesajın"} — Üç Eksen`;
    const { id: resendId } = await sendMail(env, {
      to: [conv.email],
      subject: ids.length ? `Re: ${base}` : base,
      text: emailText(msg.author, msg.body_text ?? "", conversationUrl(env, conv.reply_token)),
      replyTo: replyAddress(env, conv.plus_token),
      inReplyTo: ids.at(-1) ?? null,
      references: ids.slice(-MAX_REFERENCES),
    });
    const mid = await fetchSentMessageId(env, resendId).catch(() => null);
    await env.DB.prepare(
      "UPDATE messages SET resend_id = ?1, provider_message_id = ?2, send_status = 'sent', send_error = NULL WHERE id = ?3",
    )
      .bind(resendId, mid, msg.id)
      .run();
    return true;
  } catch (err) {
    console.error("deliverMessage failed", msg.id, err);
    await env.DB.prepare("UPDATE messages SET send_status = 'failed', send_error = ?1 WHERE id = ?2")
      .bind(String(err).slice(0, 500), msg.id)
      .run();
    return false;
  }
}

/** Stores an outgoing message, moves the conversation along, and sends it. */
export async function sendOutgoing(
  env: MailEnv,
  convId: number,
  author: Author | "system",
  body: string,
  opts: { via: "admin" | "form"; nextState?: string } = { via: "admin" },
): Promise<{ messageId: number; sent: boolean }> {
  const now = nowIso();
  const res = await env.DB.prepare(
    `INSERT INTO messages (conversation_id, direction, body_text, author, created_at, send_status, via)
     VALUES (?1, 'out', ?2, ?3, ?4, 'pending', ?5)`,
  )
    .bind(convId, body, author, now, opts.via)
    .run();
  const messageId = Number(res.meta.last_row_id);
  await env.DB.prepare(
    "UPDATE conversations SET last_message_at = ?1, state = COALESCE(?2, state) WHERE id = ?3",
  )
    .bind(now, opts.nextState ?? null, convId)
    .run();
  const sent = await deliverMessage(env, messageId);
  return { messageId, sent };
}

/** Acknowledgement after the contact form: quotes back what the customer wrote. */
export function ackBody(name: string, written: string): string {
  return [
    `Merhaba ${name},`,
    "",
    "Talebin bize ulaştı. İki iş günü içinde e-posta ya da telefonla dönüyoruz. Eklemek istediğin bir şey olursa bu e-postayı yanıtlaman yeterli.",
    "",
    "Yazdığın:",
    "",
    quoteLines(written),
  ].join("\n");
}

export type IncomingInput = {
  convId: number;
  text: string;
  raw?: string | null;
  via: "email" | "web";
  fromAddr?: string | null;
  providerMessageId?: string | null;
};

/** Stores a message from the customer and puts the conversation back on our side. */
export async function recordIncoming(env: Pick<Env, "DB">, m: IncomingInput): Promise<number> {
  const now = nowIso();
  const res = await env.DB.prepare(
    `INSERT INTO messages (conversation_id, direction, body_text, body_raw, author, created_at, via, from_addr, provider_message_id)
     VALUES (?1, 'in', ?2, ?3, 'customer', ?4, ?5, ?6, ?7)`,
  )
    .bind(m.convId, m.text, m.raw ?? null, now, m.via, m.fromAddr ?? null, m.providerMessageId ?? null)
    .run();
  await env.DB.prepare("UPDATE conversations SET last_message_at = ?1, state = 'ours' WHERE id = ?2").bind(now, m.convId).run();
  return Number(res.meta.last_row_id);
}

/** One email to all admins (one email, so the dev guard turns it into a single test email). Never throws. */
export async function notifyAdmins(env: MailEnv, subject: string, lines: string[]): Promise<void> {
  const to = parseAdmins(env.ADMIN_EMAILS).map((a) => a.email);
  if (!to.length) return;
  try {
    await sendMail(env, { to, subject: `[Üç Eksen] ${subject}`, text: lines.join("\n") });
  } catch (err) {
    console.error("notifyAdmins failed", subject, err);
  }
}

export function snippet(text: string, max = 1500): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function adminConversationUrl(env: Pick<Env, "APP_URL">, convId: number): string {
  return `${env.APP_URL}/admin/konusma/${convId}`;
}

export async function notifyNewMessage(
  env: MailEnv,
  convId: number,
  kind: string,
  text: string,
): Promise<void> {
  const conv = await loadConversation(env.DB, convId);
  if (!conv) return;
  const who = conv.name ? `${conv.name} <${conv.email}>` : conv.email;
  await notifyAdmins(env, `${kind}: ${conv.name ?? conv.email}`, [
    kind,
    "",
    who,
    `Konu: ${conv.subject ?? "—"}`,
    "",
    snippet(text),
    "",
    `Aç: ${adminConversationUrl(env, convId)}`,
  ]);
}
