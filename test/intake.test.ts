import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { DateTime } from "luxon";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { reminderBody, sendReminders } from "../src/lib/booking";
import { intakeText, parseIntake } from "../src/lib/intake";
import { isoUtc } from "../src/lib/slots";
import { signStripe } from "../src/lib/stripe";
import { fake } from "./fake-resend";
import { fakeStripe } from "./fake-stripe";
import { freshIp, messages, newConversation } from "./helpers";

const req = (path: string, init: RequestInit = {}) =>
  SELF.fetch(`https://example.com${path}`, { redirect: "manual", ...init, headers: { origin: "https://example.com", "cf-connecting-ip": freshIp(), ...init.headers } });
const form = (path: string, body: Record<string, string>) =>
  req(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() });

async function postStripe(event: unknown) {
  const body = JSON.stringify(event);
  const t = String(Math.floor(Date.now() / 1000));
  const sig = await signStripe(env.STRIPE_WEBHOOK_SECRET, t, body);
  return SELF.fetch("https://example.com/api/webhooks/stripe", { method: "POST", headers: { "stripe-signature": `t=${t},v1=${sig}` }, body });
}

let n = 0;
/** Contact form → offer → paid → first offered slot booked. */
async function booked() {
  const email = `onform${++n}@example.com`;
  const conv = await newConversation(email);
  await form(`/admin/konusma/${conv.id}/odeme`, {});
  const id = `cs_test_intake_${n}_${crypto.randomUUID().slice(0, 6)}`;
  await postStripe({
    type: "checkout.session.completed",
    data: {
      object: {
        id, object: "checkout.session", mode: "payment", status: "complete", payment_status: "paid", amount_total: 10000, currency: "eur",
        payment_intent: `pi_${id}`, invoice: null, metadata: { project: "uceksen", kind: "consult", conversation_id: String(conv.id) },
        consent: { terms_of_service: "accepted" }, customer_details: { email, name: null, address: { country: "NL" } },
      },
    },
  });
  const intent = (await env.DB.prepare("SELECT id, token FROM booking_intents WHERE stripe_session_id = ?1").bind(id).first<{ id: number; token: string }>())!;
  const start = [...(await (await req(`/randevu/${intent.token}?tz=Europe/Amsterdam`)).text()).matchAll(/name="start" value="([^"]+)"/g)].map((m) => m[1]!)[0]!;
  expect((await form(`/randevu/${intent.token}`, { start, tz: "Europe/Amsterdam" })).status).toBe(303);
  const b = (await env.DB.prepare("SELECT id FROM bookings WHERE booking_intent_id = ?1").bind(intent.id).first<{ id: number }>())!;
  return { conv, token: intent.token, bookingId: b.id, email };
}

/** Moves a booking to `start` (unique per test via a millisecond offset). */
async function moveTo(bookingId: number, start: DateTime) {
  const s = start.plus({ milliseconds: ++n });
  await env.DB.prepare("UPDATE bookings SET start_utc = ?1, end_utc = ?2 WHERE id = ?3").bind(isoUtc(s), isoUtc(s.plus({ minutes: 90 })), bookingId).run();
}

const booking = (id: number) => env.DB.prepare("SELECT * FROM bookings WHERE id = ?1").bind(id).first<Record<string, unknown>>();

const ANSWERS = { simdi: "TC vatandaşı, İstanbul", aile: "Eşim ve bir çocuk", gelir: "Kendi şirketim", sirket: "İstanbul, tek ortak, yazılım", hedef: "Hollanda, 2027 yazı", beklenti: "Şirketi mi taşıyayım, yenisini mi kurayım?", ek: "" };

beforeAll(async () => {
  await env.DB.prepare("DELETE FROM availability_rules").run();
  for (let d = 0; d < 7; d++) await env.DB.prepare("INSERT INTO availability_rules (weekday, start_time, end_time) VALUES (?1, '00:00', '24:00')").bind(d).run();
  await env.DB.prepare("UPDATE settings SET max_per_week = 50, max_horizon_days = 60 WHERE id = 1").run();
});

beforeEach(() => {
  fake.reset();
  fakeStripe.reset();
});

describe("intake form", () => {
  it("parseIntake requires only the goal question, trims and caps answers", () => {
    expect(parseIntake({ simdi: "x" })).toMatchObject({ ok: false });
    const r = parseIntake({ beklenti: "  netlik \r\n ", simdi: "a".repeat(5000) });
    expect(r.ok && r.answers.beklenti).toBe("netlik");
    expect(r.ok && r.answers.simdi?.length).toBe(3000);
    expect(intakeText({ beklenti: "x" })).toContain("Şu an neredesin?\n—");
  });

  it("is linked from the confirmation email and the booking page; saving notifies the admins and shows in admin", async () => {
    const { conv, token, bookingId, email } = await booked();
    const confirm = fake.sent.find((m) => m.text.includes("Görüşmen ayarlandı"))!;
    expect(confirm.text).toContain(`${env.APP_URL}/randevu/${token}/onform`);
    expect(await (await req(`/randevu/${token}`)).text()).toContain("Formu doldur");

    const page = await req(`/randevu/${token}/onform`);
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toContain("no-store");
    const html = await page.text();
    expect(html).toContain("Bu görüşmeden sonra neyi netleştirmiş olmak istiyorsun?");
    expect(html).toMatch(/name="beklenti"[^>]*required/);

    expect((await form(`/randevu/${token}/onform`, { ...ANSWERS, beklenti: " " })).status).toBe(400);
    fake.reset();
    const res = await form(`/randevu/${token}/onform`, ANSWERS);
    expect(res.headers.get("location")).toBe(`/randevu/${token}?onform=1#onform`);
    const b = await booking(bookingId);
    expect(JSON.parse(String(b!.intake_json))).toEqual(ANSWERS);
    expect(b!.intake_submitted_at).toBeTruthy();
    const note = fake.sent.find((m) => m.subject.includes("Ön form dolduruldu"))!;
    expect(note.text).toContain(email);
    expect(note.text).toContain("Hangi ülkeleri düşünüyorsun, zamanlaman ne?\nHollanda, 2027 yazı");

    expect(await (await req(`/randevu/${token}`)).text()).toContain("Formu düzenle");
    expect(await (await req(`/randevu/${token}/onform`)).text()).toContain("Eşim ve bir çocuk");
    expect(await (await req(`/admin/konusma/${conv.id}`)).text()).toContain("Şirketi mi taşıyayım, yenisini mi kurayım?");

    fake.reset();
    await form(`/randevu/${token}/onform`, { ...ANSWERS, ek: "Bir teklif aldım." });
    expect(fake.sent.some((m) => m.subject.includes("Ön form güncellendi"))).toBe(true);
    // Form data never goes to the customer thread.
    expect((await messages(conv.id)).some((m) => String(m.body_text).includes("Bir teklif aldım."))).toBe(false);
  });

  it("closes when the call starts and is gone for cancelled bookings", async () => {
    const { token, bookingId } = await booked();
    await moveTo(bookingId, DateTime.utc().minus({ minutes: 5 }));
    expect(await (await req(`/randevu/${token}/onform`)).text()).toContain("form artık değiştirilemiyor");
    expect((await form(`/randevu/${token}/onform`, ANSWERS)).status).toBe(409);
    expect((await booking(bookingId))!.intake_json).toBeNull();

    await env.DB.prepare("UPDATE bookings SET state = 'cancelled' WHERE id = ?1").bind(bookingId).run();
    expect((await req(`/randevu/${token}/onform`)).headers.get("location")).toBe(`/randevu/${token}`);
    expect((await req("/randevu/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/onform")).status).toBe(404);
  });
});

describe("24-hour reminder", () => {
  it("goes out once, 23–25 hours ahead, and asks for the form while it is empty", async () => {
    const now = DateTime.utc();
    const { conv, token, bookingId } = await booked();
    await moveTo(bookingId, now.plus({ hours: 26 }));
    expect(await sendReminders(env, now)).toBe(0);
    await moveTo(bookingId, now.plus({ hours: 22 }));
    expect(await sendReminders(env, now)).toBe(0);

    await moveTo(bookingId, now.plus({ hours: 24, minutes: 30 }));
    fake.reset();
    expect(await sendReminders(env, now)).toBe(1);
    const mail = fake.sent.at(-1)!;
    expect(mail.text).toContain("Yarın görüşüyoruz.");
    expect(mail.text).toContain("henüz doldurmadın");
    expect(mail.text).toContain(`/randevu/${token}/onform`);
    expect((await booking(bookingId))!.reminder_sent_at).toBeTruthy();
    expect((await messages(conv.id)).at(-1)).toMatchObject({ direction: "out", author: "system" });

    expect(await sendReminders(env, now)).toBe(0);
    expect(await sendReminders(env, now.plus({ minutes: 30 }))).toBe(0);
  });

  it("thanks for a filled form; skips cancelled bookings", async () => {
    const now = DateTime.utc();
    const a = await booked();
    await form(`/randevu/${a.token}/onform`, ANSWERS);
    await moveTo(a.bookingId, now.plus({ hours: 24, minutes: 10 }));
    const c = await booked();
    await moveTo(c.bookingId, now.plus({ hours: 24, minutes: 20 }));
    await env.DB.prepare("UPDATE bookings SET state = 'cancelled' WHERE id = ?1").bind(c.bookingId).run();
    fake.reset();
    expect(await sendReminders(env, now)).toBe(1);
    expect(fake.sent[0]!.text).toContain("Ön formun bize ulaştı");
  });

  it("shows the local time across the EU DST change", () => {
    // 28 Mar 2027 09:00Z = 11:00 in Amsterdam (CEST, after the change at 01:00Z).
    const text = reminderBody(env, { name: "Ayşe", token: "t", start: "2027-03-28T09:00:00.000Z", tz: "Europe/Amsterdam", meetUrl: "https://meet.google.com/x", intakeDone: false });
    expect(text).toMatch(/^Merhaba Ayşe,/);
    expect(text).toContain("Tarih: 28 Mart 2027 Pazar, 11:00 (Europe/Amsterdam saatiyle)");
    expect(text).toContain("Görüşme bağlantısı: https://meet.google.com/x");
  });

  it("moving the booking re-arms the reminder", async () => {
    const { token, bookingId } = await booked();
    await env.DB.prepare("UPDATE bookings SET reminder_sent_at = ?1 WHERE id = ?2").bind(isoUtc(DateTime.utc()), bookingId).run();
    const slots = [...(await (await req(`/randevu/${token}/degistir?tz=Europe/Amsterdam`)).text()).matchAll(/name="start" value="([^"]+)"/g)].map((m) => m[1]!);
    expect((await form(`/randevu/${token}/degistir`, { islem: "ertele", start: slots.at(-1)!, tz: "Europe/Amsterdam" })).status).toBe(303);
    expect((await booking(bookingId))!.reminder_sent_at).toBeNull();
  });

  it("the Worker's scheduled handler sends due reminders", async () => {
    const { bookingId } = await booked();
    await moveTo(bookingId, DateTime.utc().plus({ hours: 24, minutes: 40 }));
    fake.reset();
    const ctx = createExecutionContext();
    await worker.scheduled({ scheduledTime: Date.now(), cron: "0 * * * *", noRetry() {} } as ScheduledController, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(fake.sent.some((m) => m.text.includes("Yarın görüşüyoruz."))).toBe(true);
    expect((await booking(bookingId))!.reminder_sent_at).toBeTruthy();
  });
});

describe("written summary", () => {
  it("only after the call; lands in the thread, is emailed once, completes booking and conversation", async () => {
    const { conv, bookingId, email } = await booked();
    expect(await (await req(`/admin/konusma/${conv.id}`)).text()).toContain("Yazılı özet görüşmeden sonra");
    expect((await form(`/admin/randevu/${bookingId}/ozet`, { metin: "Özet" })).status).toBe(409);

    await moveTo(bookingId, DateTime.utc().minus({ hours: 2 }));
    expect(await (await req(`/admin/konusma/${conv.id}`)).text()).toContain("Özeti gönder");
    expect((await form(`/admin/randevu/${bookingId}/ozet`, { metin: "  " })).status).toBe(400);
    fake.reset();
    const res = await form(`/admin/randevu/${bookingId}/ozet`, { metin: "Merhaba,\r\n\r\nGörüşmenin özeti: önce oturum, sonra şirket." });
    expect(res.headers.get("location")).toBe(`/admin/konusma/${conv.id}?odeme=ozet1#danismanlik`);
    const mail = fake.sent.at(-1)!;
    expect(mail.to).toEqual(["dev@example.com"]); // DEV_EMAIL guard
    expect(mail.text).toContain(email);
    expect(mail.text).toContain("Görüşmenin özeti: önce oturum, sonra şirket.");
    expect(mail.text).toContain("Gizem\nÜç Eksen");
    expect((await messages(conv.id)).at(-1)).toMatchObject({ direction: "out", via: "admin", author: "gizem" });
    const b = await booking(bookingId);
    expect(b!.state).toBe("completed");
    expect(b!.summary_sent_at).toBeTruthy();
    expect((await env.DB.prepare("SELECT state FROM conversations WHERE id = ?1").bind(conv.id).first<{ state: string }>())!.state).toBe("completed");

    expect((await form(`/admin/randevu/${bookingId}/ozet`, { metin: "Tekrar" })).status).toBe(409);
    expect(await (await req(`/admin/konusma/${conv.id}`)).text()).toContain("Yazılı özet gönderildi");
    expect((await form("/admin/randevu/999999/ozet", { metin: "x" })).status).toBe(404);
  });
});
