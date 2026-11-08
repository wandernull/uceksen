import { Hono } from "hono";
import type { AppEnv } from "../env";
import { allow, clientIp } from "../lib/rate-limit";
import { nowIso } from "../lib/time";
import { ackBody, notifyNewMessage, sendOutgoing } from "../lib/conversations";
import { randomMailToken, randomToken } from "../lib/tokens";
import { MessagePage } from "../views/layout";

export const talep = new Hono<AppEnv>();

const SOURCES = { danismanlik: "Durum Analizi talebi", hakkimizda: "İletişim formu" } as const;
type Source = keyof typeof SOURCES;

export const LIMITS = { name: 200, email: 254, phone: 40, body: 5000 } as const;
export const RATE = { limit: 5, windowSec: 3600 } as const;

const MSG = {
  ok: "Talebin bize ulaştı. İki iş günü içinde dönüyoruz.",
  name: "Ad soyad gerekli.",
  email: "Geçerli bir e-posta adresi yaz.",
  body: "Durum özeti gerekli.",
  bodyLong: `Durum özeti çok uzun; en fazla ${LIMITS.body} karakter yazabilirsin.`,
  consent: "Devam etmek için onay kutusunu işaretle.",
  tooLong: "Girdiğin bilgilerden biri çok uzun.",
  rate: "Kısa sürede çok fazla talep gönderildi. Bir saat sonra tekrar dene.",
  error: "Bir sorun oldu. Biraz sonra tekrar dene.",
} as const;

export type TalepInput = {
  name: string;
  email: string;
  phone: string | null;
  body: string;
  source: Source;
};

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export function validate(raw: Record<string, unknown>): { ok: true; value: TalepInput } | { ok: false; error: string } {
  const name = str(raw.ad);
  const email = str(raw.email).toLowerCase();
  const phone = str(raw.telefon);
  const body = str(raw.durum).replace(/\r\n/g, "\n");
  const consent = raw.onay === true || raw.onay === "on" || raw.onay === "true";
  const sourceRaw = str(raw.kaynak);
  const source: Source = sourceRaw in SOURCES ? (sourceRaw as Source) : "hakkimizda";

  if (!name) return { ok: false, error: MSG.name };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > LIMITS.email) return { ok: false, error: MSG.email };
  if (!body) return { ok: false, error: MSG.body };
  if (body.length > LIMITS.body) return { ok: false, error: MSG.bodyLong };
  if (name.length > LIMITS.name || phone.length > LIMITS.phone) return { ok: false, error: MSG.tooLong };
  if (!consent) return { ok: false, error: MSG.consent };
  return { ok: true, value: { name, email, phone: phone || null, body, source } };
}

/** Upserts the contact and creates conversation + first message in one transaction. */
export async function storeTalep(db: D1Database, t: TalepInput): Promise<{ replyToken: string; convId: number }> {
  const now = nowIso();
  const replyToken = randomToken();
  const plusToken = randomMailToken();
  await db.batch([
    db
      .prepare(
        `INSERT INTO contacts (email, name, phone, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)
         ON CONFLICT(email) DO UPDATE SET name = excluded.name, phone = COALESCE(excluded.phone, contacts.phone), updated_at = excluded.updated_at`,
      )
      .bind(t.email, t.name, t.phone, now),
    db
      .prepare(
        `INSERT INTO conversations (contact_id, subject, state, reply_token, plus_token, last_message_at, created_at, source, consent_at)
         VALUES ((SELECT id FROM contacts WHERE email = ?1), ?2, 'new', ?3, ?4, ?5, ?5, ?6, ?5)`,
      )
      .bind(t.email, SOURCES[t.source], replyToken, plusToken, now, t.source),
    db
      .prepare(
        `INSERT INTO messages (conversation_id, direction, body_text, author, created_at, via)
         VALUES ((SELECT id FROM conversations WHERE reply_token = ?1), 'in', ?2, 'customer', ?3, 'form')`,
      )
      .bind(replyToken, t.body, now),
  ]);
  const row = await db.prepare("SELECT id FROM conversations WHERE reply_token = ?1").bind(replyToken).first<{ id: number }>();
  return { replyToken, convId: row!.id };
}

talep.post("/", async (c) => {
  const isJson = (c.req.header("content-type") ?? "").includes("application/json");
  const reply = (status: 200 | 400 | 429 | 500, ok: boolean, message: string) => {
    if (isJson) return c.json(ok ? { ok } : { ok, error: message }, status);
    // No-JS fallback: the form posts natively; answer with a page.
    const back = c.req.header("referer")?.includes("/hakkimizda") ? "/hakkimizda" : "/danismanlik";
    return c.html(
      "<!doctype html>" +
        (
          <MessagePage
            title={ok ? "Talebin alındı" : "Gönderilemedi"}
            eyebrow="Talep"
            heading={ok ? "Talebin bize ulaştı" : "Talep gönderilemedi"}
            text={message}
            back={[back, "← Geri dön"]}
          />
        ),
      status,
    );
  };

  let raw: Record<string, unknown>;
  try {
    raw = isJson ? await c.req.json() : Object.fromEntries((await c.req.formData()).entries());
  } catch {
    return reply(400, false, MSG.error);
  }

  // Honeypot: bots fill every field. Pretend success, store nothing.
  if (str(raw.website)) return reply(200, true, MSG.ok);

  if (!(await allow(c.env.KV, `talep:${clientIp(c.req.raw)}`, RATE.limit, RATE.windowSec))) {
    return reply(429, false, MSG.rate);
  }

  const v = validate(raw);
  if (!v.ok) return reply(400, false, v.error);

  let convId: number;
  try {
    ({ convId } = await storeTalep(c.env.DB, v.value));
  } catch (err) {
    console.error("talep store failed", err);
    return reply(500, false, MSG.error);
  }
  // The request is stored; email problems must not turn it into an error for the visitor.
  // A failed acknowledgement shows up in /admin with a resend button.
  await sendOutgoing(c.env, convId, "system", ackBody(v.value.name, v.value.body), { via: "form" });
  await notifyNewMessage(c.env, convId, "Yeni talep", v.value.body);
  return reply(200, true, MSG.ok);
});
