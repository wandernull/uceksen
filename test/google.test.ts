import { env, SELF } from "cloudflare:test";
import { DateTime } from "luxon";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { decryptText, encryptText } from "../src/lib/crypto";
import { SCOPES } from "../src/lib/google";
import { signStripe } from "../src/lib/stripe";
import { fake } from "./fake-resend";
import { fakeGoogle } from "./fake-google";
import { fakeStripe } from "./fake-stripe";
import { freshIp, newConversation } from "./helpers";

const req = (path: string, init: RequestInit = {}) =>
  SELF.fetch(`https://example.com${path}`, { redirect: "manual", ...init, headers: { origin: "https://example.com", "cf-connecting-ip": freshIp(), ...init.headers } });
const form = (path: string, body: Record<string, string | string[]>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) for (const x of [v].flat()) p.append(k, x);
  return req(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: p.toString() });
};

async function postStripe(event: unknown) {
  const body = JSON.stringify(event);
  const t = String(Math.floor(Date.now() / 1000));
  const sig = await signStripe(env.STRIPE_WEBHOOK_SECRET, t, body);
  return SELF.fetch("https://example.com/api/webhooks/stripe", { method: "POST", headers: { "stripe-signature": `t=${t},v1=${sig}` }, body });
}

let n = 0;
async function paidCustomer(email = `g${++n}@example.com`) {
  const conv = await newConversation(email);
  await form(`/admin/konusma/${conv.id}/odeme`, {});
  const id = `cs_test_g_${++n}_${crypto.randomUUID().slice(0, 6)}`;
  await postStripe({
    type: "checkout.session.completed",
    data: {
      object: {
        id, object: "checkout.session", mode: "payment", status: "complete", payment_status: "paid", amount_total: 20000, currency: "eur",
        payment_intent: `pi_${id}`, invoice: null, metadata: { project: "uceksen", kind: "consult", conversation_id: String(conv.id) },
        customer_details: { email, name: null, address: { country: "NL" } },
      },
    },
  });
  const intent = (await env.DB.prepare("SELECT token, id FROM booking_intents WHERE stripe_session_id = ?1").bind(id).first<{ token: string; id: number }>())!;
  return { conv, token: intent.token, intentId: intent.id };
}

const slotsOn = async (path: string) => [...(await (await req(path)).text()).matchAll(/name="start" value="([^"]+)"/g)].map((m) => m[1]!);
const bookingOf = (intentId: number) =>
  env.DB.prepare("SELECT * FROM bookings WHERE booking_intent_id = ?1 ORDER BY id DESC LIMIT 1").bind(intentId).first<Record<string, unknown>>();
const settings = () => env.DB.prepare("SELECT * FROM settings WHERE id = 1").first<Record<string, unknown>>();
const icsOf = (sent: object) => {
  const mail = sent as { attachments?: { filename: string; content: string }[] };
  const a = mail.attachments?.find((x) => x.filename.endsWith(".ics"));
  return a ? new TextDecoder().decode(Uint8Array.from(atob(a.content), (ch) => ch.charCodeAt(0))) : null;
};

/** Admin → Google consent → callback, as the browser would. */
async function connect(code = "good-code") {
  const start = await form("/admin/google/baglan", {});
  const url = new URL(start.headers.get("location")!);
  const res = await req(`/admin/google/callback?state=${url.searchParams.get("state")}&code=${code}`);
  return { url, res };
}

async function disconnectDirect() {
  await env.DB.prepare(
    "UPDATE settings SET google_refresh_token_enc = NULL, google_account = NULL, google_calendar_id = NULL, google_busy_calendars_json = '[]', google_connected_at = NULL WHERE id = 1",
  ).run();
  await env.KV.delete("google:access");
}

beforeAll(async () => {
  await env.DB.prepare("DELETE FROM availability_rules").run();
  for (let d = 0; d < 7; d++) {
    await env.DB.prepare("INSERT INTO availability_rules (weekday, start_time, end_time) VALUES (?1, '00:00', '24:00')").bind(d).run();
  }
  await env.DB.prepare("UPDATE settings SET max_per_week = 50, max_horizon_days = 60 WHERE id = 1").run();
});

beforeEach(async () => {
  fake.reset();
  fakeStripe.reset();
  fakeGoogle.reset();
  await env.KV.delete("google:alerted");
  await disconnectDirect();
});

describe("refresh token encryption", () => {
  const key = env.ENCRYPTION_KEY;
  it("round-trips, and refuses tampering, another purpose or another key", async () => {
    const enc = await encryptText(key, "p", "geheim");
    expect(enc.startsWith("v1.")).toBe(true);
    expect(enc).not.toContain("geheim");
    expect(await encryptText(key, "p", "geheim")).not.toBe(enc); // random IV
    expect(await decryptText(key, "p", enc)).toBe("geheim");
    const raw = atob(enc.slice(3));
    const flipped = `v1.${btoa(raw.slice(0, 20) + String.fromCharCode(raw.charCodeAt(20) ^ 1) + raw.slice(21))}`;
    await expect(decryptText(key, "p", flipped)).rejects.toThrow();
    await expect(decryptText(key, "other", enc)).rejects.toThrow();
    await expect(decryptText(btoa("x".repeat(32)), "p", enc)).rejects.toThrow();
  });
});

describe("connecting Google", () => {
  it("sends the admin to Google with offline access, all scopes, PKCE and the signed-in admin as the hint", async () => {
    const res = await form("/admin/google/baglan", {});
    expect(res.status).toBe(303);
    const url = new URL(res.headers.get("location")!);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const q = url.searchParams;
    expect(q.get("client_id")).toBe(env.GOOGLE_CLIENT_ID);
    expect(q.get("redirect_uri")).toBe(`${env.APP_URL}/admin/google/callback`);
    expect(q.get("scope")!.split(" ").sort()).toEqual([...SCOPES].sort());
    expect(q.get("access_type")).toBe("offline");
    expect(q.get("prompt")).toBe("consent");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("login_hint")).toBe("gizem@example.com");
    expect(q.get("state")!.length).toBeGreaterThanOrEqual(32);
  });

  it("stores the refresh token encrypted, picks the Üç Eksen calendar and sensible busy calendars", async () => {
    const { url, res } = await connect();
    expect(res.headers.get("location")).toBe("/admin/takvim?google=bagli#google");
    // PKCE: the verifier sent on exchange hashes to the challenge sent to Google.
    const verifier = fakeGoogle.tokenRequests[0]!.get("code_verifier")!;
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    const challenge = btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(url.searchParams.get("code_challenge")).toBe(challenge);

    const s = (await settings())!;
    expect(String(s.google_refresh_token_enc)).not.toContain("rt-secret");
    expect(await decryptText(env.ENCRYPTION_KEY, "google_refresh_token", String(s.google_refresh_token_enc))).toBe("rt-secret-refresh-token");
    expect(s.google_account).toBe("gizem@example.com");
    expect(s.google_calendar_id).toBe("uc-eksen-cal@group.calendar.google.com");
    // Own main calendar + Baran's shared one; not the holidays, not the booking calendar itself.
    expect(JSON.parse(String(s.google_busy_calendars_json))).toEqual(["gizem@example.com", "baran@example.com"]);
    // The access token is cached encrypted, too.
    const cached = await env.KV.get("google:access");
    expect(cached).toMatch(/^v1\./);
    expect(cached).not.toContain("at-");

    const page = await (await req("/admin/takvim")).text();
    expect(page).toContain("gizem@example.com");
    expect(page).toContain("Üç Eksen");
    expect(page).toContain("Bağlantıyı kes");
  });

  it("rejects an unknown or reused state, a denied consent, missing scopes", async () => {
    expect((await req("/admin/google/callback?state=nope&code=good-code")).headers.get("location")).toContain("google=state");

    const start = await form("/admin/google/baglan", {});
    const state = new URL(start.headers.get("location")!).searchParams.get("state");
    expect((await req(`/admin/google/callback?state=${state}&error=access_denied`)).headers.get("location")).toContain("google=denied");
    expect((await req(`/admin/google/callback?state=${state}&code=good-code`)).headers.get("location")).toContain("google=state"); // one-time

    fakeGoogle.grantedScopes = SCOPES[0]!; // user unticked boxes
    const { res } = await connect();
    expect(res.headers.get("location")).toContain("google=scopes");
    expect(fakeGoogle.revoked).toHaveLength(1);
    expect((await settings())!.google_refresh_token_enc).toBeNull();
  });

  it("says so when there is no Üç Eksen calendar; the admin can choose calendars", async () => {
    fakeGoogle.calendars = fakeGoogle.calendars.filter((c) => c.summary !== "Üç Eksen");
    fakeGoogle.calendars.push({ id: "other@group.calendar.google.com", summary: "İş", accessRole: "owner" });
    const { res } = await connect();
    expect(res.headers.get("location")).toContain("google=takvimyok");
    expect((await settings())!.google_calendar_id).toBeNull();

    const bad = await form("/admin/google/ayarlar", { takvim: "baran@example.com", dolu: [] }); // not writable
    expect(bad.headers.get("location")).toContain("google=gecersiz");
    const ok = await form("/admin/google/ayarlar", {
      takvim: "other@group.calendar.google.com",
      dolu: ["gizem@example.com", "other@group.calendar.google.com", "unknown@example.com"],
      ek: "Ortak@Example.com",
    });
    expect(ok.headers.get("location")).toContain("google=kaydedildi");
    const s = (await settings())!;
    expect(s.google_calendar_id).toBe("other@group.calendar.google.com");
    // The booking calendar is never "busy" (bookings are counted from the database); unknown ids dropped.
    expect(JSON.parse(String(s.google_busy_calendars_json))).toEqual(["gizem@example.com", "ortak@example.com"]);
  });

  it("disconnect revokes the token at Google and forgets everything", async () => {
    await connect();
    expect((await form("/admin/google/kes", {})).headers.get("location")).toContain("google=onay");
    expect((await form("/admin/google/kes", { onay: "on" })).headers.get("location")).toContain("google=kesildi");
    expect(fakeGoogle.revoked).toEqual(["rt-secret-refresh-token"]);
    const s = (await settings())!;
    expect(s.google_refresh_token_enc).toBeNull();
    expect(s.google_calendar_id).toBeNull();
    expect(await env.KV.get("google:access")).toBeNull();
  });

  it("the admin endpoints are CSRF-protected", async () => {
    const res = await SELF.fetch("https://example.com/admin/google/baglan", {
      method: "POST", redirect: "manual", headers: { origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" }, body: "",
    });
    expect(res.status).toBe(403);
  });
});

describe("freebusy", () => {
  it("an event in Google removes the slot it overlaps, including the buffers", async () => {
    const { token } = await paidCustomer();
    const before = await slotsOn(`/randevu/${token}?tz=Europe/Istanbul`);
    expect(before.length).toBeGreaterThan(3);
    await connect();
    const [a, b] = [before[0]!, before[1]!];
    // A private appointment overlapping slot a; another ending 10 min before slot b (buffer before is 15).
    fakeGoogle.busy.set("gizem@example.com", [{ start: a, end: DateTime.fromISO(a).plus({ minutes: 30 }).toUTC().toISO()! }]);
    fakeGoogle.busy.set("baran@example.com", [
      { start: DateTime.fromISO(b).minus({ hours: 1 }).toUTC().toISO()!, end: DateTime.fromISO(b).plus({ minutes: 10 }).toUTC().toISO()! },
    ]);
    const after = await slotsOn(`/randevu/${token}?tz=Europe/Istanbul`);
    expect(after).not.toContain(a);
    expect(after).not.toContain(b);
    expect(after).toContain(before[2]);
    const fb = fakeGoogle.calls.filter((c) => c.path === "/freeBusy");
    expect(fb.length).toBeGreaterThan(0);
    expect(fb[0]!.body.items).toEqual([{ id: "gizem@example.com" }, { id: "baran@example.com" }]);
    // Booking the blocked slot directly is refused too.
    const res = await form(`/randevu/${token}`, { start: a, tz: "Europe/Istanbul" });
    expect(res.status).toBe(409);
  });

  it("asks in chunks so a long horizon stays within Google's range limit", async () => {
    await env.DB.prepare("UPDATE settings SET max_horizon_days = 150 WHERE id = 1").run();
    try {
      const { token } = await paidCustomer();
      await connect();
      await slotsOn(`/randevu/${token}`);
      const fb = fakeGoogle.calls.filter((c) => c.path === "/freeBusy");
      expect(fb.length).toBe(3);
      for (const c of fb) expect(Date.parse(c.body.timeMax) - Date.parse(c.body.timeMin)).toBeLessThanOrEqual(60 * 86_400_000);
    } finally {
      await env.DB.prepare("UPDATE settings SET max_horizon_days = 60 WHERE id = 1").run();
    }
  });

  it("when Google cannot be read, no slots are offered, booking is refused and admins hear once", async () => {
    const { token, intentId } = await paidCustomer();
    const start = (await slotsOn(`/randevu/${token}`))[0]!;
    await connect();
    fakeGoogle.failFreeBusy = true;
    fake.reset();
    const page = await (await req(`/randevu/${token}`)).text();
    expect(page).toContain("Takvimi şu an kontrol edemiyoruz");
    expect(page).not.toContain('name="start"');
    const res = await form(`/randevu/${token}`, { start, tz: "Europe/Amsterdam" });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("saat kaydedilmedi");
    expect(await bookingOf(intentId)).toBeNull();
    await req(`/randevu/${token}`);
    const alerts = fake.sent.filter((m) => m.subject.includes("Google Takvim sorunu"));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.to).toEqual(["dev@example.com"]); // DEV_EMAIL guard still applies
  });

  it("a calendar that stopped sharing counts as unreadable; a revoked grant asks to reconnect", async () => {
    const { token } = await paidCustomer();
    await connect();
    fakeGoogle.busyErrors.add("baran@example.com");
    expect(await (await req(`/randevu/${token}`)).text()).toContain("Takvimi şu an kontrol edemiyoruz");
    expect(await (await req("/admin/takvim")).text()).toContain("baran@example.com: notFound");

    fakeGoogle.busyErrors.clear();
    fakeGoogle.invalidGrant = true;
    await env.KV.delete("google:access");
    await env.KV.delete("google:alerted");
    fake.reset();
    expect(await (await req(`/randevu/${token}`)).text()).toContain("Takvimi şu an kontrol edemiyoruz");
    expect(fake.sent.find((m) => m.subject.includes("Google Takvim sorunu"))!.text).toContain("yeniden bağlan");
  });
});

describe("booking events", () => {
  it("a booking creates a private event with a Meet link; the customer is not invited and Google sends nothing", async () => {
    const { token, intentId, conv } = await paidCustomer("etkinlik@example.com");
    await connect();
    const start = (await slotsOn(`/randevu/${token}`))[0]!;
    fake.reset();
    expect((await form(`/randevu/${token}`, { start, tz: "Europe/Amsterdam" })).status).toBe(303);

    const b = (await bookingOf(intentId))!;
    expect(b.gcal_status).toBe("synced");
    expect(String(b.meet_url)).toMatch(/^https:\/\/meet\.google\.com\//);
    const ev = fakeGoogle.events.get(String(b.gcal_event_id))!;
    expect(ev.calendarId).toBe("uc-eksen-cal@group.calendar.google.com");
    expect(ev).not.toHaveProperty("attendees");
    expect((ev.start as { dateTime: string }).dateTime).toBe(start);
    expect(ev.visibility).toBe("private");
    expect(String(ev.description)).toContain(`/admin/konusma/${conv.id}`);
    const insert = fakeGoogle.eventCalls("POST")[0]!;
    expect(insert.query.get("sendUpdates")).toBe("none");
    expect(insert.query.get("conferenceDataVersion")).toBe("1");

    // The confirmation and its .ics carry the link.
    const mail = fake.sent.find((m) => m.text.includes("Görüşmen ayarlandı"))!;
    expect(mail.text).toContain(`Görüşme bağlantısı: ${b.meet_url}`);
    expect(icsOf(mail)).toContain(`LOCATION:${b.meet_url}`);
    expect(icsOf(mail)).not.toContain("ATTENDEE");
    expect(await (await req(`/randevu/${token}`)).text()).toContain(String(b.meet_url));
  });

  it("reschedule moves the same event (same Meet link); cancel deletes it", async () => {
    const { token, intentId } = await paidCustomer();
    await connect();
    const [first, second] = await slotsOn(`/randevu/${token}`);
    await form(`/randevu/${token}`, { start: first!, tz: "Europe/Amsterdam" });
    const b1 = (await bookingOf(intentId))!;

    const res = await form(`/randevu/${token}/degistir`, { islem: "ertele", start: second!, tz: "Europe/Amsterdam" });
    expect(res.status).toBe(303);
    const b2 = (await bookingOf(intentId))!;
    expect(b2.gcal_event_id).toBe(b1.gcal_event_id);
    expect(b2.meet_url).toBe(b1.meet_url);
    const ev = fakeGoogle.events.get(String(b1.gcal_event_id))!;
    expect((ev.start as { dateTime: string }).dateTime).toBe(second);
    expect(fakeGoogle.events.size).toBe(1);

    await form(`/randevu/${token}/degistir`, { islem: "iptal", onay: "on", tz: "Europe/Amsterdam" });
    expect(ev.status).toBe("cancelled");
    const del = fakeGoogle.eventCalls("DELETE")[0]!;
    expect(del.query.get("sendUpdates")).toBe("none");
    // Nobody was ever invited, and Google was told not to email on any write.
    for (const c of fakeGoogle.eventCalls()) {
      if (c.method !== "GET") expect(c.query.get("sendUpdates")).toBe("none");
      expect(c.body?.attendees).toBeUndefined();
    }
  });

  it("a Google failure never loses the booking; the admin retry creates the event and mails the link", async () => {
    const { token, intentId, conv } = await paidCustomer();
    await connect();
    const start = (await slotsOn(`/randevu/${token}`))[0]!;
    fakeGoogle.failEvents = true;
    fake.reset();
    expect((await form(`/randevu/${token}`, { start, tz: "Europe/Amsterdam" })).status).toBe(303);
    const b = (await bookingOf(intentId))!;
    expect(b.state).toBe("confirmed");
    expect(b.gcal_status).toBe("failed");
    expect(b.meet_url).toBeNull();
    expect(fake.sent.find((m) => m.text.includes("Görüşmen ayarlandı"))!.text).toContain("görüşmeden önce e-postana gelecek");
    expect(fake.sent.find((m) => m.subject.includes("Randevu:"))!.text).toContain("GOOGLE TAKVİM'E YAZILAMADI");
    expect(await (await req(`/admin/konusma/${conv.id}`)).text()).toContain("Google&#39;a yazılamadı");

    fakeGoogle.failEvents = false;
    fake.reset();
    const r = await form(`/admin/randevu/${b.id}/google`, {});
    expect(r.headers.get("location")).toContain("odeme=google");
    const after = (await bookingOf(intentId))!;
    expect(after.gcal_status).toBe("synced");
    const mail = fake.sent.find((m) => m.text.includes("bağlantısı hazır"))!;
    expect(mail.text).toContain(String(after.meet_url));
    expect(icsOf(mail)).toContain(`LOCATION:${after.meet_url}`);

    // A second retry changes nothing and sends nothing.
    fake.reset();
    await form(`/admin/randevu/${b.id}/google`, {});
    expect(fake.sent).toHaveLength(0);
    expect(fakeGoogle.events.size).toBe(1);
  });

  it("without Google connected, booking works as before and nothing is sent to Google", async () => {
    const { token, intentId } = await paidCustomer();
    const start = (await slotsOn(`/randevu/${token}`))[0]!;
    expect((await form(`/randevu/${token}`, { start, tz: "Europe/Amsterdam" })).status).toBe(303);
    const b = (await bookingOf(intentId))!;
    expect(b.state).toBe("confirmed");
    expect(b.gcal_status).toBeNull();
    expect(fakeGoogle.calls).toHaveLength(0);
  });
});
