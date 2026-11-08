import { isProduction } from "../env";

const API = "https://api.resend.com";

/** Overridable in tests. Every call to Resend goes through here. */
export const resendApi: { fetch: (url: string, init?: RequestInit) => Promise<Response> } = {
  fetch: (url, init) => fetch(url, init),
};

export type OutMail = {
  to: string[];
  subject: string;
  text: string;
  replyTo?: string;
  inReplyTo?: string | null;
  references?: string[];
  /** Resend deduplicates sends with the same key (24h). */
  idempotencyKey?: string;
  attachments?: { filename: string; content: string; contentType: string }[];
};

/** UTF-8 text → base64, for attachment content. */
export function textToBase64(text: string): string {
  let bin = "";
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin);
}

export class MailGuardError extends Error {}

/**
 * Outside production every email goes to DEV_EMAIL, whatever the intended
 * recipient. The intended recipients are written at the top of the body.
 * Never bypass this. Without DEV_EMAIL nothing is sent at all.
 */
export function applyDevGuard(env: Pick<Env, "ENVIRONMENT" | "DEV_EMAIL">, mail: OutMail): OutMail {
  if (isProduction(env)) return mail;
  const dev = env.DEV_EMAIL?.trim();
  if (!dev) throw new MailGuardError("DEV_EMAIL is not set; refusing to send outside production");
  return {
    ...mail,
    to: [dev],
    subject: `[TEST] ${mail.subject}`,
    text: `[Geliştirme ortamı — asıl alıcı: ${mail.to.join(", ")}]\n\n${mail.text}`,
  };
}

async function call<T>(env: Pick<Env, "RESEND_API_KEY">, path: string, init: RequestInit = {}): Promise<T> {
  const res = await resendApi.fetch(API + path, {
    ...init,
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json", ...init.headers },
  });
  if (!res.ok) throw new Error(`Resend ${init.method ?? "GET"} ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

/** Sends through Resend (after the dev guard). Returns Resend's email id. */
export async function sendMail(
  env: Pick<Env, "ENVIRONMENT" | "DEV_EMAIL" | "RESEND_API_KEY" | "MAIL_FROM">,
  mail: OutMail,
): Promise<{ id: string }> {
  const m = applyDevGuard(env, mail);
  const headers: Record<string, string> = {};
  if (m.inReplyTo) headers["In-Reply-To"] = m.inReplyTo;
  if (m.references?.length) headers["References"] = m.references.join(" ");
  return call<{ id: string }>(env, "/emails", {
    method: "POST",
    headers: m.idempotencyKey ? { "Idempotency-Key": m.idempotencyKey } : {},
    body: JSON.stringify({
      from: env.MAIL_FROM,
      to: m.to,
      subject: m.subject,
      text: m.text,
      ...(m.replyTo ? { reply_to: m.replyTo } : {}),
      ...(Object.keys(headers).length ? { headers } : {}),
      ...(m.attachments?.length
        ? { attachments: m.attachments.map((a) => ({ filename: a.filename, content: a.content, content_type: a.contentType })) }
        : {}),
    }),
  });
}

/** The RFC Message-ID SES assigned to a sent email; null until Resend knows it. */
export async function fetchSentMessageId(env: Pick<Env, "RESEND_API_KEY">, resendId: string): Promise<string | null> {
  const r = await call<{ message_id?: string | null }>(env, `/emails/${encodeURIComponent(resendId)}`);
  return r.message_id || null;
}

export type ReceivedEmail = {
  id: string;
  from: string;
  to: string[];
  cc?: string[];
  received_for?: string[];
  subject: string | null;
  message_id: string | null;
  text: string | null;
  html: string | null;
  headers?: Record<string, string>;
  attachments?: { id: string; filename: string; content_type: string; size: number }[];
};

export async function fetchReceivedEmail(env: Pick<Env, "RESEND_API_KEY">, id: string): Promise<ReceivedEmail> {
  return call<ReceivedEmail>(env, `/emails/receiving/${encodeURIComponent(id)}`);
}

export async function fetchReceivedAttachments(
  env: Pick<Env, "RESEND_API_KEY">,
  id: string,
): Promise<{ id: string; filename: string; content_type: string; size: number; download_url: string }[]> {
  const r = await call<{ data: { id: string; filename: string; content_type: string; size: number; download_url: string }[] }>(
    env,
    `/emails/receiving/${encodeURIComponent(id)}/attachments`,
  );
  return r.data ?? [];
}
