import { env, SELF } from "cloudflare:test";
import { signWebhook } from "../src/lib/webhook-signature";

let ip = 0;
export const freshIp = () => `192.0.2.${(++ip % 250) + 1}`;

/** Submits the contact form and returns the new conversation. */
export async function newConversation(email: string, durum = "Hollanda'da şirketim var.", name = "Ayşe Yılmaz") {
  const res = await SELF.fetch("https://example.com/api/talep", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": freshIp() },
    body: JSON.stringify({ ad: name, email, durum, onay: "on", kaynak: "danismanlik" }),
  });
  if (res.status !== 200) throw new Error(`talep ${res.status}`);
  return (await env.DB.prepare(
    `SELECT c.id, c.reply_token, c.plus_token, c.state FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
      WHERE ct.email = ?1 ORDER BY c.id DESC LIMIT 1`,
  ).bind(email.toLowerCase()).first<{ id: number; reply_token: string; plus_token: string; state: string }>())!;
}

export async function messages(convId: number) {
  return (await env.DB.prepare("SELECT * FROM messages WHERE conversation_id = ?1 ORDER BY id").bind(convId).all<Record<string, unknown>>()).results;
}

export async function postWebhook(event: unknown, opts: { secret?: string; timestamp?: number; tamper?: boolean } = {}) {
  const body = JSON.stringify(event);
  const id = `msg_${crypto.randomUUID()}`;
  const ts = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
  const sig = await signWebhook(opts.secret ?? env.RESEND_INBOUND_SECRET, id, ts, body);
  return SELF.fetch("https://example.com/api/webhooks/resend", {
    method: "POST",
    headers: { "content-type": "application/json", "svix-id": id, "svix-timestamp": ts, "svix-signature": `v1,${sig}` },
    body: opts.tamper ? body.replace("email", "emaiL") : body,
  });
}
