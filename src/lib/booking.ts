import { DateTime } from "luxon";
import type { Author } from "../env";
import { AUTHOR_NAME, deliverMessage, notifyAdmins, sendOutgoing } from "./conversations";
import { googleBusy, GoogleError, googleProblem, syncBookingEvent, type GoogleEnv, type SyncResult } from "./google";
import { formatEur } from "./guide";
import { loadAvailability } from "./settings";
import { computeSlots, formatSlot, isoUtc, SESSION_MINUTES } from "./slots";
import { isSettled, refundPayment, retrieveInvoice, type CheckoutSession } from "./stripe";
import { nowIso } from "./time";
import { randomToken } from "./tokens";

type BookingEnv = Pick<
  Env,
  | "DB" | "ENVIRONMENT" | "DEV_EMAIL" | "RESEND_API_KEY" | "MAIL_FROM" | "MAIL_DOMAIN" | "REPLY_LOCAL" | "REPLY_DOMAIN" | "APP_URL"
  | "ADMIN_EMAILS" | "STRIPE_SECRET_KEY"
> & GoogleEnv;

/** Policy from /satis-kosullari. */
export const CONSULT = { intentDays: 60, rescheduleHours: 24, refundHours: 48, maxReschedules: 2 } as const;
const LIVE = "('confirmed', 'rescheduled')";

export const randevuUrl = (env: Pick<Env, "APP_URL">, token: string) => `${env.APP_URL}/randevu/${token}`;
export const manageUrl = (env: Pick<Env, "APP_URL">, token: string) => `${env.APP_URL}/randevu/${token}/degistir`;
export const paymentUrl = (env: Pick<Env, "APP_URL">, replyToken: string) => `${env.APP_URL}/konusma/${replyToken}/odeme`;

const hello = (name: string | null) => (name ? `Merhaba ${name},` : "Merhaba,");
const when = (iso: string, tz: string) => `${formatSlot(iso, tz)} (${tz.replace(/_/g, " ")} saatiyle)`;

// --- 1. Admin opens the payment step ---------------------------------------------------

export function offerBody(env: Pick<Env, "APP_URL">, name: string | null, replyToken: string): string {
  return [
    hello(name),
    "",
    "Durumunu okuduk; Durum Analizi senin için uygun. Ödeme ve randevu adımına buradan geçebilirsin:",
    paymentUrl(env, replyToken),
    "",
    "Ücret €100 (KDV dahil): 90 dakika görüşme ve birkaç gün içinde yazılı özet. Ödemeden hemen sonra takvimden sana uyan saati seçiyorsun.",
  ].join("\n");
}

export async function offerConsult(env: BookingEnv, convId: number, author: Author): Promise<{ sent: boolean } | null> {
  const conv = await env.DB.prepare(
    "SELECT c.reply_token, ct.name FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE c.id = ?1",
  ).bind(convId).first<{ reply_token: string; name: string | null }>();
  if (!conv) return null;
  await env.DB.prepare("UPDATE conversations SET consult_offered_at = COALESCE(consult_offered_at, ?1) WHERE id = ?2").bind(nowIso(), convId).run();
  const { sent } = await sendOutgoing(env, convId, author, offerBody(env, conv.name, conv.reply_token), { via: "admin", nextState: "theirs" });
  return { sent };
}

// --- 2. Payment → booking intent ---------------------------------------------------------

export function paidBody(env: Pick<Env, "APP_URL">, p: { name: string | null; token: string; amount: string; invoiceUrl: string | null }): string {
  return [
    hello(p.name),
    "",
    "Ödemen alındı, teşekkürler. Şimdi görüşme saatini seçebilirsin:",
    randevuUrl(env, p.token),
    "",
    `Bağlantı ${CONSULT.intentDays} gün geçerli. Saatleri kendi saat diliminde görürsün.`,
    "",
    `Ödenen: ${p.amount} (KDV dahil)`,
    p.invoiceUrl ? `Fatura: ${p.invoiceUrl}` : "Faturan ayrı bir e-postayla gelecek.",
  ].join("\n");
}

export type ConsultResult = { result: "created" | "duplicate" | "ignored" | "unpaid"; token?: string };

/**
 * checkout.session.completed (or the success page, whichever comes first) for the
 * consultation. Idempotent per Checkout session: intent, conversation state and the
 * "pick a time" message are written in one transaction.
 */
export async function fulfillConsult(env: BookingEnv, s: CheckoutSession): Promise<ConsultResult> {
  if (s.metadata?.project !== "uceksen" || s.metadata?.kind !== "consult" || s.mode !== "payment") return { result: "ignored" };
  if (!isSettled(s)) return { result: "unpaid" };
  const db = env.DB;
  const existing = await db.prepare("SELECT token FROM booking_intents WHERE stripe_session_id = ?1").bind(s.id).first<{ token: string }>();
  if (existing) return { result: "duplicate", token: existing.token };

  const convId = Number(s.metadata.conversation_id);
  const conv = await db.prepare(
    "SELECT c.id, c.contact_id, ct.name, ct.email FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE c.id = ?1",
  ).bind(convId).first<{ id: number; contact_id: number; name: string | null; email: string }>();
  if (!conv) {
    // Paid, but nothing to attach it to: a retry would not help, so tell a human.
    console.error("consult session without conversation", s.id, s.metadata.conversation_id);
    await notifyAdmins(env, "Eşleşmeyen Durum Analizi ödemesi", [
      "Bir Durum Analizi ödemesi geldi ama bağlı konuşma bulunamadı. Stripe panelinden kontrol et.",
      "",
      `Checkout: ${s.id}`,
      `E-posta: ${s.customer_details?.email ?? "—"}`,
      `Tutar: ${formatEur(s.amount_total ?? 0, s.currency ?? "eur")}`,
    ]);
    return { result: "ignored" };
  }

  let invoiceUrl: string | null = null;
  if (s.invoice) invoiceUrl = await retrieveInvoice(env, s.invoice).then((i) => i.hosted_invoice_url, () => null);
  const paid = formatEur(s.amount_total ?? 0, s.currency ?? "eur");
  const amount = s.currency_conversion?.amount_total ?? s.amount_total ?? 0;
  const currency = s.currency_conversion?.source_currency ?? s.currency ?? "eur";
  const token = randomToken();
  const now = nowIso();
  try {
    await db.batch([
      db.prepare(
        `INSERT INTO booking_intents (token, contact_id, stripe_session_id, expires_at, created_at, conversation_id,
                                      stripe_payment_intent, amount_cents, currency, country, stripe_invoice_id, invoice_url)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
      ).bind(
        token, conv.contact_id, s.id, isoUtc(DateTime.utc().plus({ days: CONSULT.intentDays })), now, conv.id,
        s.payment_intent, amount, currency, s.customer_details?.address?.country ?? null, s.invoice, invoiceUrl,
      ),
      db.prepare("UPDATE conversations SET state = 'awaiting_booking', last_message_at = ?1 WHERE id = ?2").bind(now, conv.id),
      db.prepare(
        `INSERT INTO messages (conversation_id, direction, body_text, author, created_at, send_status, via)
         VALUES (?1, 'out', ?2, 'system', ?3, 'pending', 'system')`,
      ).bind(conv.id, paidBody(env, { name: conv.name, token, amount: paid, invoiceUrl }), now),
    ]);
  } catch (err) {
    const again = await db.prepare("SELECT token FROM booking_intents WHERE stripe_session_id = ?1").bind(s.id).first<{ token: string }>();
    if (again) return { result: "duplicate", token: again.token };
    throw err;
  }
  const pending = await db.prepare(
    "SELECT id FROM messages WHERE conversation_id = ?1 AND direction = 'out' AND send_status = 'pending' ORDER BY id",
  ).bind(conv.id).all<{ id: number }>();
  for (const m of pending.results) await deliverMessage(env, m.id);
  await notifyAdmins(env, `Ödeme alındı: ${conv.name ?? conv.email}`, [
    "Durum Analizi ödemesi alındı. Müşteri saat seçecek.",
    "",
    conv.name ? `${conv.name} <${conv.email}>` : conv.email,
    `Tutar: ${formatEur(amount, currency)}${s.currency_conversion ? ` (müşteri ${paid} ödedi)` : ""}`,
    "",
    `Aç: ${env.APP_URL}/admin/konusma/${conv.id}`,
  ]);
  return { result: "created", token };
}

// --- 3. Booking ----------------------------------------------------------------------------

export type Intent = {
  id: number; token: string; contact_id: number; conversation_id: number; expires_at: string; used_at: string | null;
  stripe_payment_intent: string | null; amount_cents: number | null; currency: string | null; name: string | null; email: string;
};
export type Booking = {
  id: number; start_utc: string; end_utc: string; customer_tz: string; state: string; reschedule_count: number;
  meet_url: string | null; cancelled_by: string | null; refund_status: string | null;
};

export async function loadIntent(db: D1Database, token: string): Promise<{ intent: Intent; booking: Booking | null } | null> {
  const intent = await db.prepare(
    `SELECT i.id, i.token, i.contact_id, i.conversation_id, i.expires_at, i.used_at, i.stripe_payment_intent, i.amount_cents, i.currency,
            ct.name, ct.email
       FROM booking_intents i JOIN contacts ct ON ct.id = i.contact_id WHERE i.token = ?1`,
  ).bind(token).first<Intent>();
  if (!intent) return null;
  const booking = await db.prepare(
    `SELECT id, start_utc, end_utc, customer_tz, state, reschedule_count, meet_url, cancelled_by, refund_status
       FROM bookings WHERE booking_intent_id = ?1 ORDER BY id DESC LIMIT 1`,
  ).bind(intent.id).first<Booking>();
  return { intent, booking };
}

export const isLive = (b: Booking | null): b is Booking => !!b && (b.state === "confirmed" || b.state === "rescheduled");

export function policy(b: Booking, now = DateTime.utc()) {
  const start = DateTime.fromISO(b.start_utc, { zone: "utc" });
  const live = isLive(b) && start > now;
  return {
    canReschedule: live && start > now.plus({ hours: CONSULT.rescheduleHours }) && b.reschedule_count < CONSULT.maxReschedules,
    canCancel: live,
    refundable: live && start > now.plus({ hours: CONSULT.refundHours }),
  };
}

/**
 * Slots on offer right now (optionally ignoring one booking: the one being moved).
 * Throws GoogleError when Google is connected but cannot be read.
 */
export async function availableSlots(env: GoogleEnv, excludeBookingId?: number, now = DateTime.utc()) {
  const a = await loadAvailability(env.DB, { excludeBookingId });
  const busy = await googleBusy(env, now, now.plus({ days: a.settings.max_horizon_days + 2 }));
  return computeSlots({ ...a, busy: busy ?? [], now });
}

/** For pages: no slots (and one admin alert per 6 hours) while Google cannot be read. */
export async function offeredSlots(env: BookingEnv, excludeBookingId?: number) {
  try {
    return { slots: await availableSlots(env, excludeBookingId), problem: null };
  } catch (err) {
    if (!(err instanceof GoogleError)) throw err;
    console.error("slots: google", err.message);
    await alertGoogle(env, err);
    return { slots: [], problem: googleProblem(err) };
  }
}

async function alertGoogle(env: BookingEnv, err: unknown) {
  const key = "google:alerted";
  if (await env.KV.get(key)) return;
  await env.KV.put(key, "1", { expirationTtl: 6 * 3600 });
  await notifyAdmins(env, "Google Takvim sorunu", [
    googleProblem(err),
    "",
    "Sorun sürdükçe müşteriler boş saat göremez.",
    `Kontrol: ${env.APP_URL}/admin/takvim`,
  ]);
}

/** Line for the admin notification when the Google event could not be written. */
const googleLine = (g: SyncResult) =>
  g.status === "failed" ? ["", `GOOGLE TAKVİM'E YAZILAMADI: ${g.error ?? ""}`, "Konuşma sayfasından tekrar dene."] : [];

/** Slots for a booking request; a Google failure means "cannot check now". */
async function slotsForBooking(env: BookingEnv, excludeBookingId: number | undefined, now: DateTime<true>) {
  try {
    return await availableSlots(env, excludeBookingId, now);
  } catch (err) {
    if (!(err instanceof GoogleError)) throw err;
    await alertGoogle(env, err);
    return null;
  }
}

/**
 * Bounds that another live booking must not cross for a session at [start, end):
 * its end + buffer_after must be ≤ start, its start − buffer_before must be ≥ end.
 */
async function bufferBounds(db: D1Database, startIso: string, endIso: string) {
  const s = await db.prepare("SELECT buffer_before_min AS b, buffer_after_min AS a FROM settings WHERE id = 1").first<{ b: number; a: number }>();
  return {
    lo: isoUtc(DateTime.fromISO(startIso, { zone: "utc" }).minus({ minutes: s?.a ?? 30 })),
    hi: isoUtc(DateTime.fromISO(endIso, { zone: "utc" }).plus({ minutes: s?.b ?? 15 })),
  };
}

const isUniqueError = (err: unknown) => /UNIQUE|constraint/i.test(String(err));

export function confirmBody(env: Pick<Env, "APP_URL">, p: { name: string | null; token: string; start: string; tz: string; meetUrl: string | null }): string {
  return [
    hello(p.name),
    "",
    "Görüşmen ayarlandı.",
    "",
    `Tarih: ${when(p.start, p.tz)}`,
    `Süre: ${SESSION_MINUTES} dakika`,
    p.meetUrl ? `Görüşme bağlantısı: ${p.meetUrl}` : "Görüşme bağlantısı (Google Meet) görüşmeden önce e-postana gelecek.",
    "",
    "Takvimine eklemek için ekteki dosyayı aç.",
    "",
    `Saati değiştirmek ya da iptal etmek için: ${manageUrl(env, p.token)}`,
    `Saat, görüşmeye ${CONSULT.rescheduleHours} saatten fazla varken en fazla ${CONSULT.maxReschedules} kez değiştirilebilir. ${CONSULT.refundHours} saatten fazla varken iptal edersen ücretin tamamı iade edilir.`,
  ].join("\n");
}

export type BookResult = { ok: true; bookingId: number } | { ok: false; reason: "taken" | "unavailable" | "expired" | "already" | "calendar" };

/** Books one slot for a paid intent. The database decides who gets a contested slot. */
export async function bookSlot(env: BookingEnv, intent: Intent, startIso: string, tz: string): Promise<BookResult> {
  const now = DateTime.utc();
  if (intent.used_at) return { ok: false, reason: "already" };
  if (DateTime.fromISO(intent.expires_at, { zone: "utc" }) <= now) return { ok: false, reason: "expired" };
  const offered = await slotsForBooking(env, undefined, now);
  if (!offered) return { ok: false, reason: "calendar" };
  const slot = offered.find((s) => s.start === startIso);
  if (!slot) return { ok: false, reason: "unavailable" };

  const { lo, hi } = await bufferBounds(env.DB, slot.start, slot.end);
  const ts = nowIso();
  let res: D1Result;
  try {
    // One statement: the overlap check and the insert cannot be split by another request.
    // The partial UNIQUE index on start_utc is the final lock.
    res = await env.DB.prepare(
      `INSERT INTO bookings (conversation_id, contact_id, booking_intent_id, start_utc, end_utc, customer_tz, state, created_at, updated_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'confirmed', ?7, ?7
        WHERE NOT EXISTS (SELECT 1 FROM bookings WHERE state IN ${LIVE} AND start_utc < ?8 AND end_utc > ?9)
          AND NOT EXISTS (SELECT 1 FROM bookings WHERE booking_intent_id = ?3)`,
    ).bind(intent.conversation_id, intent.contact_id, intent.id, slot.start, slot.end, tz, ts, hi, lo).run();
  } catch (err) {
    if (isUniqueError(err)) return { ok: false, reason: "taken" };
    throw err;
  }
  if (!res.meta.changes) {
    const mine = await env.DB.prepare("SELECT 1 FROM bookings WHERE booking_intent_id = ?1").bind(intent.id).first();
    return { ok: false, reason: mine ? "already" : "taken" };
  }
  const bookingId = Number(res.meta.last_row_id);
  await env.DB.batch([
    env.DB.prepare("UPDATE booking_intents SET used_at = ?1 WHERE id = ?2").bind(ts, intent.id),
    env.DB.prepare("UPDATE conversations SET state = 'theirs' WHERE id = ?1").bind(intent.conversation_id),
  ]);
  // Database first (above); only now Google. The email carries the Meet link if it worked.
  const g = await syncBookingEvent(env, bookingId);
  await sendOutgoing(env, intent.conversation_id, "system", confirmBody(env, { name: intent.name, token: intent.token, start: slot.start, tz, meetUrl: g.meetUrl }), {
    via: "system",
    bookingId,
  });
  await notifyAdmins(env, `Randevu: ${intent.name ?? intent.email}`, [
    "Yeni randevu.",
    "",
    intent.name ? `${intent.name} <${intent.email}>` : intent.email,
    `Tarih: ${when(slot.start, await hostTz(env.DB))}`,
    `Müşterinin saat dilimi: ${tz}`,
    ...googleLine(g),
    "",
    `Aç: ${env.APP_URL}/admin/konusma/${intent.conversation_id}`,
  ]);
  return { ok: true, bookingId };
}

const hostTz = async (db: D1Database) =>
  (await db.prepare("SELECT host_tz FROM settings WHERE id = 1").first<{ host_tz: string }>())?.host_tz ?? "Europe/Istanbul";

// --- 4. Reschedule ---------------------------------------------------------------------------

export function rescheduleBody(env: Pick<Env, "APP_URL">, p: { name: string | null; token: string; start: string; tz: string; left: number }): string {
  return [
    hello(p.name),
    "",
    "Görüşmenin saati değişti.",
    "",
    `Yeni tarih: ${when(p.start, p.tz)}`,
    "",
    "Güncellenmiş takvim dosyası ekte; açtığında takvimindeki görüşme yeni saate taşınır.",
    "",
    p.left > 0 ? `Saati ${p.left} kez daha değiştirebilirsin: ${manageUrl(env, p.token)}` : `Saat değiştirme hakkın doldu. İptal için: ${manageUrl(env, p.token)}`,
  ].join("\n");
}

export async function rescheduleBooking(
  env: BookingEnv,
  intent: Intent,
  booking: Booking,
  startIso: string,
  tz: string,
): Promise<{ ok: true } | { ok: false; reason: "not_allowed" | "unavailable" | "taken" | "calendar" }> {
  const now = DateTime.utc();
  if (!policy(booking, now).canReschedule) return { ok: false, reason: "not_allowed" };
  const offered = await slotsForBooking(env, booking.id, now);
  if (!offered) return { ok: false, reason: "calendar" };
  const slot = offered.find((s) => s.start === startIso);
  if (!slot || slot.start === booking.start_utc) return { ok: false, reason: "unavailable" };
  const { lo, hi } = await bufferBounds(env.DB, slot.start, slot.end);
  let res: D1Result;
  try {
    res = await env.DB.prepare(
      `UPDATE bookings SET start_utc = ?1, end_utc = ?2, customer_tz = ?3, state = 'rescheduled',
              reschedule_count = reschedule_count + 1, updated_at = ?4
        WHERE id = ?5 AND state IN ${LIVE} AND reschedule_count < ?6 AND start_utc > ?7
          AND NOT EXISTS (SELECT 1 FROM bookings b2 WHERE b2.id != ?5 AND b2.state IN ${LIVE} AND b2.start_utc < ?8 AND b2.end_utc > ?9)`,
    ).bind(
      slot.start, slot.end, tz, nowIso(), booking.id, CONSULT.maxReschedules, isoUtc(now.plus({ hours: CONSULT.rescheduleHours })), hi, lo,
    ).run();
  } catch (err) {
    if (isUniqueError(err)) return { ok: false, reason: "taken" };
    throw err;
  }
  if (!res.meta.changes) return { ok: false, reason: "taken" };
  const left = CONSULT.maxReschedules - (booking.reschedule_count + 1);
  const g = await syncBookingEvent(env, booking.id);
  await sendOutgoing(env, intent.conversation_id, "system", rescheduleBody(env, { name: intent.name, token: intent.token, start: slot.start, tz, left }), {
    via: "system",
    bookingId: booking.id,
  });
  const host = await hostTz(env.DB);
  await notifyAdmins(env, `Randevu değişti: ${intent.name ?? intent.email}`, [
    "Müşteri görüşmenin saatini değiştirdi.",
    "",
    intent.name ? `${intent.name} <${intent.email}>` : intent.email,
    `Eski: ${when(booking.start_utc, host)}`,
    `Yeni: ${when(slot.start, host)}`,
    ...googleLine(g),
    "",
    `Aç: ${env.APP_URL}/admin/konusma/${intent.conversation_id}`,
  ]);
  return { ok: true };
}

// --- 5. Cancel -----------------------------------------------------------------------------------

export function cancelBody(p: { name: string | null; start: string; tz: string; by: "customer" | "admin"; refund: "refunded" | "not_eligible" | "failed" | "free"; amount: string }): string {
  const refund = {
    free: "Görüşme ücretsiz olduğu için iade edilecek bir tutar yok.",
    refunded: `${p.amount} ödediğin yönteme iade edildi. Hesabına geçmesi 5–10 iş günü sürebilir.`,
    not_eligible: `Görüşmeye ${CONSULT.refundHours} saatten az kaldığı için satış koşullarına göre iade yapılmadı.`,
    failed: "İade işlemini başlatırken bir sorun oldu; birkaç gün içinde elle yapıp sana yazacağız.",
  }[p.refund];
  return [
    hello(p.name),
    "",
    p.by === "admin"
      ? `${when(p.start, p.tz)} tarihli görüşmeni iptal etmek zorunda kaldık, özür dileriz.`
      : `${when(p.start, p.tz)} tarihli görüşmen iptal edildi.`,
    "",
    refund,
    "",
    "Ekteki dosyayı açarsan görüşme takviminden de iptal olarak işaretlenir.",
  ].join("\n");
}

/**
 * Cancels a live booking. The slot is freed first (state change), then the refund is
 * attempted: customers get one only more than 48 hours ahead, admin cancellations always.
 */
export async function cancelBooking(
  env: BookingEnv,
  intent: Intent,
  booking: Booking,
  by: "customer" | "admin",
  adminAuthor?: Author,
): Promise<{ ok: true; refund: "refunded" | "not_eligible" | "failed" | "free" } | { ok: false }> {
  const now = DateTime.utc();
  const p = policy(booking, now);
  if (!p.canCancel) return { ok: false };
  const eligible = by === "admin" || p.refundable;
  const res = await env.DB.prepare(
    `UPDATE bookings SET state = 'cancelled', cancelled_at = ?1, cancelled_by = ?2, updated_at = ?1
      WHERE id = ?3 AND state IN ${LIVE}`,
  ).bind(nowIso(), by, booking.id).run();
  if (!res.meta.changes) return { ok: false };

  // "free": paid nothing (100% discount code), so there is nothing to refund. Stored as NULL.
  const free = (intent.amount_cents ?? 0) === 0 && !intent.stripe_payment_intent;
  let refund: "refunded" | "not_eligible" | "failed" | "free" = free ? "free" : "not_eligible";
  let refundId: string | null = null;
  if (eligible && !free) {
    try {
      if (!intent.stripe_payment_intent) throw new Error("no payment intent on booking intent");
      refundId = (await refundPayment(env, intent.stripe_payment_intent, `uceksen-refund-booking-${booking.id}`)).id;
      refund = "refunded";
    } catch (err) {
      console.error("refund failed", booking.id, err);
      refund = "failed";
    }
  }
  const g = await syncBookingEvent(env, booking.id);
  await env.DB.batch([
    env.DB.prepare("UPDATE bookings SET refund_status = ?1, stripe_refund_id = ?2 WHERE id = ?3").bind(refund === "free" ? null : refund, refundId, booking.id),
    env.DB.prepare("UPDATE conversations SET state = ?1 WHERE id = ?2").bind(refund === "failed" ? "ours" : "closed", intent.conversation_id),
  ]);
  const amount = formatEur(intent.amount_cents ?? 0, intent.currency ?? "eur");
  await sendOutgoing(env, intent.conversation_id, by === "admin" && adminAuthor ? adminAuthor : "system",
    cancelBody({ name: intent.name, start: booking.start_utc, tz: booking.customer_tz, by, refund, amount }),
    { via: by === "admin" ? "admin" : "system", bookingId: booking.id },
  );
  await notifyAdmins(env, `Randevu iptal: ${intent.name ?? intent.email}${refund === "failed" ? " — İADE BAŞARISIZ" : ""}`, [
    by === "admin" ? `${adminAuthor ? AUTHOR_NAME[adminAuthor] : "Yönetici"} görüşmeyi iptal etti.` : "Müşteri görüşmeyi iptal etti.",
    "",
    intent.name ? `${intent.name} <${intent.email}>` : intent.email,
    `Tarih: ${when(booking.start_utc, await hostTz(env.DB))}`,
    `İade: ${{ refunded: `yapıldı (${amount})`, not_eligible: "yok (48 saatten az kalmıştı)", failed: "BAŞARISIZ — Stripe panelinden elle yap", free: "gerekmiyor (indirim koduyla ücretsizdi)" }[refund]}`,
    ...(g.status === "failed" ? ["", `Google Takvim'deki etkinlik silinemedi (${g.error ?? ""}); elle sil.`] : []),
    "",
    `Aç: ${env.APP_URL}/admin/konusma/${intent.conversation_id}`,
  ]);
  return { ok: true, refund };
}

// --- 6. Google retry (admin) -----------------------------------------------------------------------

export function meetBody(env: Pick<Env, "APP_URL">, p: { name: string | null; token: string; start: string; tz: string; meetUrl: string }): string {
  return [
    hello(p.name),
    "",
    "Görüşmenin bağlantısı hazır:",
    p.meetUrl,
    "",
    `Tarih: ${when(p.start, p.tz)}`,
    "",
    "Güncel takvim dosyası ekte; açtığında bağlantı takvimindeki görüşmeye eklenir.",
    "",
    `Saati değiştirmek ya da iptal etmek için: ${manageUrl(env, p.token)}`,
  ].join("\n");
}

/**
 * Admin's "try Google again". If this is what finally created the Meet link, the customer
 * (who was told the link would follow) gets it by email with the updated calendar file.
 */
export async function retryGoogle(env: BookingEnv, bookingId: number): Promise<SyncResult | null> {
  const before = await env.DB.prepare(
    `SELECT b.meet_url, b.start_utc, b.customer_tz, i.token, i.conversation_id, ct.name
       FROM bookings b JOIN booking_intents i ON i.id = b.booking_intent_id JOIN contacts ct ON ct.id = b.contact_id WHERE b.id = ?1`,
  ).bind(bookingId).first<{ meet_url: string | null; start_utc: string; customer_tz: string; token: string; conversation_id: number; name: string | null }>();
  if (!before) return null;
  const g = await syncBookingEvent(env, bookingId);
  const now = await env.DB.prepare("SELECT state, start_utc FROM bookings WHERE id = ?1").bind(bookingId).first<{ state: string; start_utc: string }>();
  const live = now && (now.state === "confirmed" || now.state === "rescheduled");
  if (g.status === "synced" && g.meetUrl && !before.meet_url && live) {
    await sendOutgoing(env, before.conversation_id, "system",
      meetBody(env, { name: before.name, token: before.token, start: now.start_utc, tz: before.customer_tz, meetUrl: g.meetUrl }),
      { via: "system", bookingId });
  }
  return g;
}
