import { env, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
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
function consultSession(convId: number, email: string, over: Record<string, unknown> = {}) {
  const id = `cs_test_consult_${++n}_${crypto.randomUUID().slice(0, 6)}`;
  return {
    id, object: "checkout.session", mode: "payment", status: "complete", payment_status: "paid",
    amount_total: 20000, currency: "eur", payment_intent: `pi_${id}`, invoice: null,
    metadata: { project: "uceksen", kind: "consult", conversation_id: String(convId) },
    consent: { terms_of_service: "accepted" },
    customer_details: { email, name: null, address: { country: "NL" } },
    ...over,
  };
}

/** Contact form → admin offers → customer pays (webhook). Returns the booking token. */
async function paidCustomer(email = `musteri${++n}@example.com`) {
  const conv = await newConversation(email);
  expect((await form(`/admin/konusma/${conv.id}/odeme`, {})).status).toBe(303);
  const s = consultSession(conv.id, email);
  const res = await postStripe({ type: "checkout.session.completed", data: { object: s } });
  expect(await res.json()).toMatchObject({ result: "created" });
  const intent = (await env.DB.prepare("SELECT token, id FROM booking_intents WHERE stripe_session_id = ?1").bind(s.id).first<{ token: string; id: number }>())!;
  return { conv, s, token: intent.token, intentId: intent.id };
}

const slotsOn = async (path: string) => [...(await (await req(path)).text()).matchAll(/name="start" value="([^"]+)"/g)].map((m) => m[1]!);

async function book(token: string, start?: string, tz = "Europe/Amsterdam") {
  const s = start ?? (await slotsOn(`/randevu/${token}?tz=${tz}`))[0]!;
  return { start: s, res: await form(`/randevu/${token}`, { start: s, tz }) };
}

const bookingOf = (intentId: number) =>
  env.DB.prepare("SELECT * FROM bookings WHERE booking_intent_id = ?1 ORDER BY id DESC LIMIT 1").bind(intentId).first<Record<string, unknown>>();

const icsOf = (mail: { attachments?: { filename: string; content: string }[] }) => {
  const a = mail.attachments?.find((x) => x.filename.endsWith(".ics"));
  return a ? new TextDecoder().decode(Uint8Array.from(atob(a.content), (ch) => ch.charCodeAt(0))) : null;
};

beforeAll(async () => {
  // Open every day 00:00–24:00 so tests always find slots; plenty of room per week.
  await env.DB.prepare("DELETE FROM availability_rules").run();
  for (let d = 0; d < 7; d++) {
    await env.DB.prepare("INSERT INTO availability_rules (weekday, start_time, end_time) VALUES (?1, '00:00', '24:00')").bind(d).run();
  }
  await env.DB.prepare("UPDATE settings SET max_per_week = 50, max_horizon_days = 60 WHERE id = 1").run();
});

beforeEach(() => {
  fake.reset();
  fakeStripe.reset();
});

describe("payment step", () => {
  it("the payment page exists only after an admin opened it; it starts a consult Checkout", async () => {
    const conv = await newConversation("teklif@example.com");
    expect((await req(`/konusma/${conv.reply_token}/odeme`)).status).toBe(404);
    fake.reset();
    expect((await form(`/admin/konusma/${conv.id}/odeme`, {})).status).toBe(303);
    expect(fake.sent[0]!.text).toContain(`/konusma/${conv.reply_token}/odeme`);
    expect(fake.sent[0]!.text).toContain("Gizem\nÜç Eksen"); // signed by the admin
    const st = await env.DB.prepare("SELECT state, consult_offered_at FROM conversations WHERE id = ?1").bind(conv.id).first<{ state: string; consult_offered_at: string }>();
    expect(st!.state).toBe("theirs");
    expect(st!.consult_offered_at).toBeTruthy();

    expect((await req(`/konusma/${conv.reply_token}/odeme`)).status).toBe(200);
    const res = await form(`/konusma/${conv.reply_token}/odeme`, {});
    expect(res.status).toBe(303);
    const p = fakeStripe.sessions[0]!;
    expect(p.get("line_items[0][price]")).toBe(env.STRIPE_PRICE_CONSULT);
    expect(p.get("metadata[kind]")).toBe("consult");
    expect(p.get("metadata[conversation_id]")).toBe(String(conv.id));
    expect(p.get("customer_email")).toBe("teklif@example.com");
    expect(p.get("consent_collection[terms_of_service]")).toBe("required");
    expect(p.get("success_url")).toContain("/odeme/tamam?oturum={CHECKOUT_SESSION_ID}");
  });

  it("payment (webhook) creates a 60-day intent and emails the booking link; redelivery does nothing", async () => {
    const { conv, s, token } = await paidCustomer();
    const intent = await env.DB.prepare("SELECT * FROM booking_intents WHERE token = ?1").bind(token).first<Record<string, unknown>>();
    expect(intent).toMatchObject({ conversation_id: conv.id, amount_cents: 20000, currency: "eur", stripe_payment_intent: s.payment_intent });
    const days = (Date.parse(String(intent!.expires_at)) - Date.now()) / 86_400_000;
    expect(Math.round(days)).toBe(60);
    const mail = fake.sent.find((m) => m.text.includes(`/randevu/${token}`))!;
    expect(mail.subject).toContain("Re: Durum Analizi talebi");
    expect(mail.text).toContain("Ödenen: €200,00 (KDV dahil)");
    expect(fake.sent.some((m) => m.subject.includes("Ödeme alındı"))).toBe(true);
    const st = await env.DB.prepare("SELECT state FROM conversations WHERE id = ?1").bind(conv.id).first<{ state: string }>();
    expect(st!.state).toBe("awaiting_booking");

    fake.reset();
    expect(await (await postStripe({ type: "checkout.session.completed", data: { object: s } })).json()).toMatchObject({ result: "duplicate" });
    expect(fake.sent).toHaveLength(0);
    // Paying twice is prevented: the payment page now forwards to the booking page.
    const again = await req(`/konusma/${conv.reply_token}/odeme`);
    expect(again.headers.get("location")).toBe(`/randevu/${token}`);
  });

  it("the success page fulfils by itself when it beats the webhook", async () => {
    const conv = await newConversation("hizli@example.com");
    await form(`/admin/konusma/${conv.id}/odeme`, {});
    const s = consultSession(conv.id, "hizli@example.com");
    fakeStripe.stored.set(s.id, s);
    const res = await req(`/odeme/tamam?oturum=${s.id}`);
    expect(res.status).toBe(303);
    const token = res.headers.get("location")!.split("/").pop()!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(await (await postStripe({ type: "checkout.session.completed", data: { object: s } })).json()).toMatchObject({ result: "duplicate" });
    expect((await req("/odeme/tamam?oturum=nonsense")).status).toBe(404);
  });
});

describe("/randevu/{token}", () => {
  it("lists slots in the requested time zone, defaulting to the host's", async () => {
    const { token } = await paidCustomer();
    const res = await req(`/randevu/${token}?tz=America/New_York`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const html = await res.text();
    expect(html).toContain('<option value="America/New_York" selected');
    expect(html).toContain('src="/randevu.js"');
    const ny = await slotsOn(`/randevu/${token}?tz=America/New_York`);
    const ist = await slotsOn(`/randevu/${token}?tz=bogus/zone`);
    expect(ny).toEqual(ist); // same instants, only the labels differ
    expect(await (await req(`/randevu/${token}?tz=bogus/zone`)).text()).toContain('<option value="Europe/Istanbul" selected');
    expect((await req(`/randevu/${"x".repeat(32)}`)).status).toBe(404);
  });

  it("books a slot: confirmation email with .ics, intent used, conversation waiting for the call", async () => {
    const { conv, token, intentId } = await paidCustomer();
    fake.reset();
    const { start, res } = await book(token);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/randevu/${token}?ayarlandi=1`);
    const b = await bookingOf(intentId);
    expect(b).toMatchObject({ start_utc: start, state: "confirmed", customer_tz: "Europe/Amsterdam", conversation_id: conv.id });
    expect(Date.parse(String(b!.end_utc)) - Date.parse(start)).toBe(90 * 60_000);

    const mail = fake.sent.find((m) => m.text.includes("Görüşmen ayarlandı"))!;
    expect(mail.text).toContain("Europe/Amsterdam saatiyle");
    expect(mail.text).toContain(`/randevu/${token}/degistir`);
    const ics = icsOf(mail as never)!;
    expect(ics).toContain("METHOD:PUBLISH");
    expect(ics).toContain("ORGANIZER;CN=Üç Eksen:mailto:merhaba@uceksen.com");
    expect(ics).toContain(`DTSTART:${start.replace(/[-:]/g, "").replace(/\.000/, "")}`);
    expect(ics).not.toContain("ATTENDEE");
    expect(fake.sent.some((m) => m.subject.includes("Randevu:"))).toBe(true);

    const page = await (await req(`/randevu/${token}`)).text();
    expect(page).toContain("Görüşmen ayarlandı");
    const dl = await req(`/randevu/${token}/takvim.ics`);
    expect(dl.headers.get("content-type")).toContain("text/calendar");
    // A second booking with the same paid link is refused.
    const second = await book(token, (await slotsOn(`/randevu/${(await paidCustomer()).token}`))[2]);
    expect(second.res.headers.get("location")).toBe(`/randevu/${token}`);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM bookings WHERE booking_intent_id = ?1").bind(intentId).first<{ n: number }>();
    expect(count!.n).toBe(1);
  });

  it("two concurrent requests for the same slot: exactly one wins", async () => {
    const a = await paidCustomer();
    const b = await paidCustomer();
    const c = await paidCustomer();
    const slot = (await slotsOn(`/randevu/${a.token}`))[5]!;
    const results = await Promise.all([a, b, c].map((x) => form(`/randevu/${x.token}`, { start: slot, tz: "Europe/Istanbul" })));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([303, 409, 409]);
    const loser = results.find((r) => r.status === 409)!;
    expect(await loser.text()).toMatch(/az önce doldu|artık seçilemiyor/);
    const live = await env.DB.prepare("SELECT COUNT(*) AS n FROM bookings WHERE start_utc = ?1 AND state IN ('confirmed','rescheduled')").bind(slot).first<{ n: number }>();
    expect(live!.n).toBe(1);
  });

  it("refuses a slot that is not on offer, and an expired link", async () => {
    const { token, intentId } = await paidCustomer();
    expect((await form(`/randevu/${token}`, { start: "2026-01-01T07:00:00.000Z", tz: "Europe/Istanbul" })).status).toBe(409);
    await env.DB.prepare("UPDATE booking_intents SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?1").bind(intentId).run();
    expect((await req(`/randevu/${token}`)).status).toBe(410);
  });
});

describe("reschedule and cancel", () => {
  it("reschedules twice at most, each time with an updated .ics (same UID, higher SEQUENCE)", async () => {
    const { token, intentId } = await paidCustomer();
    await book(token);
    for (let i = 1; i <= 2; i++) {
      fake.reset();
      const options = await slotsOn(`/randevu/${token}/degistir`);
      const before = await bookingOf(intentId);
      expect(options).not.toContain(before!.start_utc);
      const res = await form(`/randevu/${token}/degistir`, { islem: "ertele", start: options[3]!, tz: "Europe/Berlin" });
      expect(res.headers.get("location")).toBe(`/randevu/${token}?degisti=1`);
      const after = await bookingOf(intentId);
      expect(after).toMatchObject({ id: before!.id, start_utc: options[3], state: "rescheduled", reschedule_count: i, customer_tz: "Europe/Berlin" });
      const ics = icsOf(fake.sent.find((m) => m.text.includes("saati değişti"))! as never)!;
      expect(ics).toContain(`SEQUENCE:${i}`);
      expect(ics).toContain(`UID:booking-${before!.id}@uceksen.com`);
    }
    const page = await (await req(`/randevu/${token}/degistir`)).text();
    expect(page).toContain("bu hakkın doldu");
    const any = (await slotsOn(`/randevu/${(await paidCustomer()).token}`))[7]!;
    expect((await form(`/randevu/${token}/degistir`, { islem: "ertele", start: any, tz: "Europe/Istanbul" })).status).toBe(409);
  });

  it("a moved booking frees its old slot", async () => {
    const { token, intentId } = await paidCustomer();
    const { start } = await book(token);
    const other = await paidCustomer();
    expect(await slotsOn(`/randevu/${other.token}`)).not.toContain(start);
    const options = await slotsOn(`/randevu/${token}/degistir`);
    await form(`/randevu/${token}/degistir`, { islem: "ertele", start: options.at(-1)!, tz: "Europe/Istanbul" });
    expect((await bookingOf(intentId))!.start_utc).toBe(options.at(-1));
    expect(await slotsOn(`/randevu/${other.token}`)).toContain(start);
  });

  it("cancel more than 48 h ahead: full refund, slot freed, cancellation .ics", async () => {
    const { s, token, intentId, conv } = await paidCustomer();
    const { start } = await book(token);
    fake.reset();
    expect((await form(`/randevu/${token}/degistir`, { islem: "iptal", tz: "Europe/Istanbul" })).status).toBe(400); // needs the checkbox
    const res = await form(`/randevu/${token}/degistir`, { islem: "iptal", onay: "on", tz: "Europe/Istanbul" });
    expect(res.headers.get("location")).toBe(`/randevu/${token}?iptal=1`);
    expect(fakeStripe.refunds).toEqual([{ payment_intent: s.payment_intent, idempotencyKey: expect.stringContaining("refund-booking-") }]);
    const b = await bookingOf(intentId);
    expect(b).toMatchObject({ state: "cancelled", cancelled_by: "customer", refund_status: "refunded" });
    expect(b!.stripe_refund_id).toMatch(/^re_/);
    const mail = fake.sent.find((m) => m.text.includes("iptal edildi"))!;
    expect(mail.text).toContain("€200,00 ödediğin yönteme iade edildi");
    expect(icsOf(mail as never)).toContain("STATUS:CANCELLED");
    const other = await paidCustomer();
    expect(await slotsOn(`/randevu/${other.token}`)).toContain(start);
    const st = await env.DB.prepare("SELECT state FROM conversations WHERE id = ?1").bind(conv.id).first<{ state: string }>();
    expect(st!.state).toBe("closed");
    expect(await (await req(`/randevu/${token}`)).text()).toContain("Görüşme iptal edildi");
    // The cancelled link cannot book again.
    expect((await book(token, (await slotsOn(`/randevu/${other.token}`))[0]!)).res.headers.get("location")).toBe(`/randevu/${token}`);
  });

  it("cancel less than 48 h ahead: no refund; less than 24 h: no reschedule", async () => {
    const { token, intentId } = await paidCustomer();
    await book(token);
    const b = (await bookingOf(intentId))!;
    const soon = new Date(Date.now() + 20 * 3600_000).toISOString();
    const soonEnd = new Date(Date.now() + 21.5 * 3600_000).toISOString();
    await env.DB.prepare("UPDATE bookings SET start_utc = ?1, end_utc = ?2 WHERE id = ?3").bind(soon, soonEnd, b.id).run();
    const page = await (await req(`/randevu/${token}/degistir`)).text();
    expect(page).toContain("saat artık değiştirilemiyor");
    expect(page).toContain("iade yapılmaz");
    fake.reset();
    await form(`/randevu/${token}/degistir`, { islem: "iptal", onay: "on", tz: "Europe/Istanbul" });
    expect(fakeStripe.refunds).toHaveLength(0);
    expect(await bookingOf(intentId)).toMatchObject({ state: "cancelled", refund_status: "not_eligible" });
    expect(fake.sent.find((m) => m.text.includes("iptal edildi"))!.text).toContain("iade yapılmadı");
  });

  it("a failed refund is flagged to the admins and the conversation goes back to us", async () => {
    const { token, intentId, conv } = await paidCustomer();
    await book(token);
    fake.reset();
    fakeStripe.failRefunds = true;
    await form(`/randevu/${token}/degistir`, { islem: "iptal", onay: "on", tz: "Europe/Istanbul" });
    expect(await bookingOf(intentId)).toMatchObject({ state: "cancelled", refund_status: "failed" });
    expect(fake.sent.some((m) => m.subject.includes("İADE BAŞARISIZ"))).toBe(true);
    const st = await env.DB.prepare("SELECT state FROM conversations WHERE id = ?1").bind(conv.id).first<{ state: string }>();
    expect(st!.state).toBe("ours");
  });

  it("a free booking (100% code): booked normally, cancelling refunds nothing and says so", async () => {
    const email = `ucretsiz${++n}@example.com`;
    const conv = await newConversation(email);
    await form(`/admin/konusma/${conv.id}/odeme`, {});
    const s = consultSession(conv.id, email, { payment_status: "no_payment_required", amount_total: 0, payment_intent: null });
    expect(await (await postStripe({ type: "checkout.session.completed", data: { object: s } })).json()).toMatchObject({ result: "created" });
    const intent = (await env.DB.prepare("SELECT token, id FROM booking_intents WHERE stripe_session_id = ?1").bind(s.id).first<{ token: string; id: number }>())!;
    const { res } = await book(intent.token);
    expect(res.status).toBe(303);
    fake.reset();
    fakeStripe.refunds = [];
    await form(`/randevu/${intent.token}/degistir`, { islem: "iptal", onay: "on", tz: "Europe/Istanbul" });
    expect(await bookingOf(intent.id)).toMatchObject({ state: "cancelled", refund_status: null });
    expect(fakeStripe.refunds).toHaveLength(0);
    expect(fake.sent.find((m) => m.text.includes("iptal edildi"))!.text).toContain("ücretsiz olduğu için iade edilecek bir tutar yok");
    expect(fake.sent.find((m) => m.subject.includes("Randevu iptal"))!.text).toContain("gerekmiyor");
  });

  it("an admin cancellation always refunds, even inside 48 h", async () => {
    const { s, token, intentId, conv } = await paidCustomer();
    await book(token);
    const b = (await bookingOf(intentId))!;
    await env.DB.prepare("UPDATE bookings SET start_utc = ?1, end_utc = ?2 WHERE id = ?3")
      .bind(new Date(Date.now() + 10 * 3600_000).toISOString(), new Date(Date.now() + 11.5 * 3600_000).toISOString(), b.id).run();
    expect((await form(`/admin/randevu/${b.id}/iptal`, {})).status).toBe(400);
    fake.reset();
    const res = await form(`/admin/randevu/${b.id}/iptal`, { onay: "on" });
    expect(res.headers.get("location")).toBe(`/admin/konusma/${conv.id}?odeme=iptal#danismanlik`);
    expect(fakeStripe.refunds[0]!.payment_intent).toBe(s.payment_intent);
    expect(await bookingOf(intentId)).toMatchObject({ state: "cancelled", cancelled_by: "admin", refund_status: "refunded" });
    expect(fake.sent.find((m) => m.text.includes("iptal etmek zorunda kaldık"))!.text).toContain("Gizem\nÜç Eksen");
    expect((await form(`/admin/randevu/${b.id}/iptal`, { onay: "on" })).status).toBe(409);
  });

  it("the admin conversation shows payment and booking", async () => {
    const { conv, token } = await paidCustomer();
    await book(token);
    const html = await (await req(`/admin/konusma/${conv.id}`)).text();
    expect(html).toContain("Durum Analizi");
    expect(html).toContain("€200,00");
    expect(html).toContain("Onaylandı");
    expect(html).toContain(`/admin/randevu/`);
  });
});

describe("the database lock", () => {
  it("rejects a second live booking at the same start_utc, but a cancelled one does not block", async () => {
    const ct = (await env.DB.prepare("INSERT INTO contacts (email) VALUES ('lock@example.com') RETURNING id").first<{ id: number }>())!.id;
    const ins = (state: string) =>
      env.DB.prepare("INSERT INTO bookings (contact_id, start_utc, end_utc, customer_tz, state) VALUES (?1, '2030-01-01T07:00:00.000Z', '2030-01-01T08:30:00.000Z', 'Europe/Istanbul', ?2)")
        .bind(ct, state).run();
    await ins("cancelled");
    await ins("confirmed");
    await expect(ins("confirmed")).rejects.toThrow(/UNIQUE/);
    await expect(ins("rescheduled")).rejects.toThrow(/UNIQUE/);
    await ins("cancelled");
  });
});

describe("/admin/takvim", () => {
  it("adds and removes rules and exceptions, validates settings, lists upcoming bookings", async () => {
    expect((await form("/admin/takvim/kural", { gun: "2", baslangic: "10:00", bitis: "17:00" })).status).toBe(303);
    await form("/admin/takvim/kural", { gun: "2", baslangic: "10:00", bitis: "17:00" });
    const dup = await env.DB.prepare("SELECT COUNT(*) AS n FROM availability_rules WHERE weekday = 2 AND start_time = '10:00'").first<{ n: number }>();
    expect(dup!.n).toBe(1);
    expect((await form("/admin/takvim/kural", { gun: "2", baslangic: "17:00", bitis: "10:00" })).status).toBe(400);
    expect((await form("/admin/takvim/istisna", { tarih: "2026-12-24", tur: "block", baslangic: "", bitis: "", not: "Tatil" })).status).toBe(303);
    expect((await form("/admin/takvim/istisna", { tarih: "2026-12-26", tur: "extra", baslangic: "", bitis: "" })).status).toBe(400);
    expect((await form("/admin/takvim/ayarlar", {
      host_tz: "Mars/Olympus", slot_times: "10:00", min_notice_hours: "48", max_horizon_days: "45", buffer_before_min: "15", buffer_after_min: "30", max_per_week: "3",
    })).status).toBe(400);
    expect((await form("/admin/takvim/ayarlar", {
      host_tz: "Europe/Istanbul", slot_times: "25:00", min_notice_hours: "48", max_horizon_days: "45", buffer_before_min: "15", buffer_after_min: "30", max_per_week: "3",
    })).status).toBe(400);
    expect((await form("/admin/takvim/ayarlar", {
      host_tz: "Europe/Istanbul", slot_times: "16:00, 10:00,14:00, 9:30", min_notice_hours: "48", max_horizon_days: "60", buffer_before_min: "15", buffer_after_min: "30", max_per_week: "50",
    })).status).toBe(303);
    const s = await env.DB.prepare("SELECT slot_times_json FROM settings WHERE id = 1").first<{ slot_times_json: string }>();
    expect(JSON.parse(s!.slot_times_json)).toEqual(["09:30", "10:00", "14:00", "16:00"]);

    const { token, conv } = await paidCustomer("takvim@example.com");
    await book(token);
    const html = await (await req("/admin/takvim")).text();
    expect(html).toContain("Tatil");
    expect(html).toContain("Çarşamba 10:00–17:00");
    expect(html).toContain(`/admin/konusma/${conv.id}#danismanlik`);
    const rule = html.match(/\/admin\/takvim\/kural\/(\d+)\/sil/)![1];
    expect((await form(`/admin/takvim/kural/${rule}/sil`, {})).status).toBe(303);
  });
});

it("messages of a booking are stored in the conversation thread", async () => {
  const { conv, token } = await paidCustomer();
  await book(token);
  const bodies = (await messages(conv.id)).map((m) => String(m.body_text));
  expect(bodies.some((b) => b.includes("Ödemen alındı"))).toBe(true);
  expect(bodies.some((b) => b.includes("Görüşmen ayarlandı"))).toBe(true);
});
