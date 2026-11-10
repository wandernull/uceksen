import { DateTime } from "luxon";
import { decryptText, encryptText } from "./crypto";
import { getHostTz } from "./settings";
import { isoUtc, type Busy } from "./slots";
import { nowIso } from "./time";
import { randomToken } from "./tokens";

/**
 * Google Calendar (SPEC §5.4–5.5). Gizem connects her Google account once from /admin;
 * the refresh token is stored AES-GCM encrypted. Freebusy on the chosen calendars removes
 * slots; each booking gets an event with a Meet link in the "Üç Eksen" calendar.
 * The customer is never an attendee and every write uses sendUpdates=none: Google sends
 * nobody anything. The database is always written first; Google follows.
 */

/** Overridable in tests. Every call to Google goes through here. */
export const googleApi: { fetch: (url: string, init?: RequestInit) => Promise<Response> } = {
  fetch: (url, init) => fetch(url, init),
};

export const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.freebusy",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
];
const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const REVOKE = "https://oauth2.googleapis.com/revoke";
const CAL = "https://www.googleapis.com/calendar/v3";
const REFRESH_PURPOSE = "google_refresh_token";
const ACCESS_PURPOSE = "google_access_token";
const ACCESS_KEY = "google:access";
/** Google rejects very long freebusy ranges; ask in chunks. */
const FREEBUSY_CHUNK_DAYS = 60;

export type GoogleEnv = Pick<Env, "DB" | "KV" | "APP_URL" | "ENVIRONMENT" | "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET" | "ENCRYPTION_KEY">;

export class GoogleError extends Error {
  constructor(message: string, readonly status = 0, readonly code?: string) {
    super(message);
    this.name = "GoogleError";
  }
}

export const redirectUri = (env: Pick<Env, "APP_URL">) => `${env.APP_URL}/admin/google/callback`;

// --- Settings ------------------------------------------------------------------------------------

export type GoogleSettings = { refreshEnc: string | null; account: string | null; calendarId: string | null; busy: string[]; connectedAt: string | null };

export async function getGoogleSettings(db: D1Database): Promise<GoogleSettings> {
  const r = await db.prepare(
    "SELECT google_refresh_token_enc, google_account, google_calendar_id, google_busy_calendars_json, google_connected_at FROM settings WHERE id = 1",
  ).first<{ google_refresh_token_enc: string | null; google_account: string | null; google_calendar_id: string | null; google_busy_calendars_json: string; google_connected_at: string | null }>();
  let busy: unknown = [];
  try {
    busy = JSON.parse(r?.google_busy_calendars_json ?? "[]");
  } catch {
    busy = [];
  }
  return {
    refreshEnc: r?.google_refresh_token_enc ?? null,
    account: r?.google_account ?? null,
    calendarId: r?.google_calendar_id ?? null,
    busy: Array.isArray(busy) ? busy.map(String) : [],
    connectedAt: r?.google_connected_at ?? null,
  };
}

export async function saveCalendarChoices(db: D1Database, calendarId: string, busy: string[]): Promise<void> {
  await db.prepare("UPDATE settings SET google_calendar_id = ?1, google_busy_calendars_json = ?2, updated_at = ?3 WHERE id = 1")
    .bind(calendarId, JSON.stringify([...new Set(busy)].filter((id) => id !== calendarId)), nowIso()).run();
}

// --- OAuth ---------------------------------------------------------------------------------------

const b64url = (bytes: Uint8Array) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const sha256 = async (s: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));

/** Consent URL. State (one-time, 10 min, bound to the admin) and the PKCE verifier live in KV. */
export async function authUrl(env: GoogleEnv, admin: string, loginHint?: string): Promise<string> {
  const state = randomToken();
  const verifier = randomToken(48);
  await env.KV.put(`google:state:${state}`, JSON.stringify({ verifier, admin }), { expirationTtl: 600 });
  const p = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(env),
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent", // always return a refresh token, also on reconnect
    state,
    code_challenge: b64url(await sha256(verifier)),
    code_challenge_method: "S256",
  });
  if (loginHint) p.set("login_hint", loginHint);
  return `${AUTH}?${p}`;
}

type TokenResponse = { access_token: string; expires_in: number; refresh_token?: string; scope?: string; error?: string; error_description?: string };

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const res = await googleApi.fetch(TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !body.access_token) {
    throw new GoogleError(`token: ${body.error ?? res.status}${body.error_description ? ` (${body.error_description})` : ""}`, res.status, body.error);
  }
  return body;
}

async function cacheAccess(env: GoogleEnv, tok: TokenResponse) {
  const ttl = Math.max(60, (tok.expires_in || 3600) - 300);
  const value = await encryptText(env.ENCRYPTION_KEY, ACCESS_PURPOSE, JSON.stringify({ token: tok.access_token, exp: Date.now() + ttl * 1000 }));
  await env.KV.put(ACCESS_KEY, value, { expirationTtl: ttl });
}

export type ConnectResult =
  | { ok: true; account: string; calendarFound: boolean }
  | { ok: false; error: "state" | "denied" | "scopes" | "no_refresh" | "google" };

export async function finishAuth(env: GoogleEnv, q: { state?: string; code?: string; error?: string }, admin: string): Promise<ConnectResult> {
  if (!q.state) return { ok: false, error: "state" };
  const key = `google:state:${q.state}`;
  const raw = await env.KV.get(key);
  if (!raw) return { ok: false, error: "state" };
  await env.KV.delete(key);
  const st = JSON.parse(raw) as { verifier: string; admin: string };
  if (st.admin !== admin) return { ok: false, error: "state" };
  if (q.error || !q.code) return { ok: false, error: "denied" };

  let tok: TokenResponse;
  try {
    tok = await tokenRequest({
      code: q.code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(env),
      grant_type: "authorization_code",
      code_verifier: st.verifier,
    });
  } catch (err) {
    console.error("google token exchange", err);
    return { ok: false, error: "google" };
  }
  // Google lets the user untick individual permissions on the consent screen.
  const granted = new Set((tok.scope ?? "").split(/\s+/));
  if (!SCOPES.every((s) => granted.has(s))) {
    await revoke(tok.refresh_token ?? tok.access_token);
    return { ok: false, error: "scopes" };
  }
  if (!tok.refresh_token) return { ok: false, error: "no_refresh" };

  let cals: CalendarEntry[];
  try {
    cals = await calendarList(tok.access_token);
  } catch (err) {
    console.error("google calendarList", err);
    return { ok: false, error: "google" };
  }
  const account = cals.find((c) => c.primary)?.id ?? "";
  const target = pickEventCalendar(cals);
  const now = nowIso();
  await env.DB.prepare(
    `UPDATE settings SET google_refresh_token_enc = ?1, google_account = ?2, google_calendar_id = ?3,
            google_busy_calendars_json = ?4, google_connected_at = ?5, updated_at = ?5 WHERE id = 1`,
  ).bind(
    await encryptText(env.ENCRYPTION_KEY, REFRESH_PURPOSE, tok.refresh_token),
    account,
    target?.id ?? null,
    JSON.stringify(defaultBusy(cals, target?.id)),
    now,
  ).run();
  await cacheAccess(env, tok);
  return { ok: true, account, calendarFound: !!target };
}

async function revoke(token: string) {
  try {
    await googleApi.fetch(REVOKE, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }).toString() });
  } catch (err) {
    console.error("google revoke", err);
  }
}

export async function disconnect(env: GoogleEnv): Promise<void> {
  const s = await getGoogleSettings(env.DB);
  if (s.refreshEnc) {
    try {
      await revoke(await decryptText(env.ENCRYPTION_KEY, REFRESH_PURPOSE, s.refreshEnc));
    } catch (err) {
      console.error("google disconnect", err);
    }
  }
  await env.DB.prepare(
    `UPDATE settings SET google_refresh_token_enc = NULL, google_account = NULL, google_connected_at = NULL,
            google_calendar_id = NULL, google_busy_calendars_json = '[]', updated_at = ?1 WHERE id = 1`,
  ).bind(nowIso()).run();
  await env.KV.delete(ACCESS_KEY);
}

async function accessToken(env: GoogleEnv, s: GoogleSettings): Promise<string> {
  const cached = await env.KV.get(ACCESS_KEY);
  if (cached) {
    try {
      const t = JSON.parse(await decryptText(env.ENCRYPTION_KEY, ACCESS_PURPOSE, cached)) as { token: string; exp: number };
      if (t.exp > Date.now() + 60_000) return t.token;
    } catch {
      // unreadable cache: refresh below
    }
  }
  if (!s.refreshEnc) throw new GoogleError("Google bağlı değil", 0, "not_connected");
  const tok = await tokenRequest({
    refresh_token: await decryptText(env.ENCRYPTION_KEY, REFRESH_PURPOSE, s.refreshEnc),
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    grant_type: "refresh_token",
  });
  await cacheAccess(env, tok);
  return tok.access_token;
}

// --- Calendar API --------------------------------------------------------------------------------

type ApiResult = { status: number; data: any }; // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(token: string, method: string, path: string, body?: unknown): Promise<ApiResult> {
  const res = await googleApi.fetch(CAL + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

async function api(env: GoogleEnv, s: GoogleSettings, method: string, path: string, body?: unknown): Promise<ApiResult> {
  let r = await call(await accessToken(env, s), method, path, body);
  if (r.status === 401) {
    // Cached access token no longer valid (revoked or rotated): refresh once.
    await env.KV.delete(ACCESS_KEY);
    r = await call(await accessToken(env, s), method, path, body);
  }
  return r;
}

const failure = (what: string, r: ApiResult) => new GoogleError(`${what}: ${r.status} ${r.data?.error?.message ?? ""}`.trim(), r.status);

export type CalendarEntry = { id: string; summary: string; primary: boolean; accessRole: string };

async function calendarList(token: string): Promise<CalendarEntry[]> {
  const r = await call(token, "GET", "/users/me/calendarList?minAccessRole=freeBusyReader&maxResults=250");
  if (r.status !== 200) throw failure("calendarList", r);
  return ((r.data?.items ?? []) as { id: string; summary?: string; summaryOverride?: string; primary?: boolean; accessRole: string }[]).map((c) => ({
    id: c.id,
    summary: c.summaryOverride ?? c.summary ?? c.id,
    primary: !!c.primary,
    accessRole: c.accessRole,
  }));
}

export async function listCalendars(env: GoogleEnv): Promise<CalendarEntry[]> {
  const s = await getGoogleSettings(env.DB);
  return calendarList(await accessToken(env, s));
}

export const isWritable = (c: CalendarEntry) => c.accessRole === "owner" || c.accessRole === "writer";
const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("tr").replace(/ı/g, "i").trim();

/** The calendar named "Üç Eksen" (any spelling of the accents) that we may write to. */
export function pickEventCalendar(cals: CalendarEntry[]): CalendarEntry | undefined {
  return cals.find((c) => isWritable(c) && fold(c.summary) === "uc eksen");
}

/**
 * Busy by default: the account's own main calendar and people's calendars shared with it
 * (ids that are personal addresses, e.g. Baran's). Not by default: holidays, subscriptions
 * and secondary calendars (…calendar.google.com), and the booking calendar itself, whose
 * events are our own bookings and already counted from the database.
 */
export function defaultBusy(cals: CalendarEntry[], eventCalendarId?: string): string[] {
  return cals.filter((c) => c.id !== eventCalendarId && (c.primary || !/calendar\.google\.com$/i.test(c.id))).map((c) => c.id);
}

/**
 * Busy time from Google between two instants, or null when Google is not connected.
 * Throws GoogleError when any chosen calendar cannot be read: callers then offer no slots
 * rather than risk booking over a private appointment.
 */
export async function googleBusy(env: GoogleEnv, from: DateTime, to: DateTime): Promise<Busy[] | null> {
  const s = await getGoogleSettings(env.DB);
  if (!s.refreshEnc) return null;
  const ids = s.busy.filter((id) => id !== s.calendarId);
  if (!ids.length) return [];
  const out: Busy[] = [];
  for (let a = from; a < to; a = a.plus({ days: FREEBUSY_CHUNK_DAYS })) {
    const b = DateTime.min(a.plus({ days: FREEBUSY_CHUNK_DAYS }), to);
    const r = await api(env, s, "POST", "/freeBusy", { timeMin: isoUtc(a), timeMax: isoUtc(b), items: ids.map((id) => ({ id })) });
    if (r.status !== 200) throw failure("freeBusy", r);
    for (const id of ids) {
      const cal = r.data?.calendars?.[id] as { busy?: Busy[]; errors?: { reason: string }[] } | undefined;
      if (!cal || cal.errors?.length) {
        throw new GoogleError(`freeBusy ${id}: ${cal?.errors?.map((e) => e.reason).join(", ") ?? "yanıt yok"}`, 200, "calendar");
      }
      out.push(...(cal.busy ?? []));
    }
  }
  return out;
}

// --- Booking events ------------------------------------------------------------------------------

const BASE32HEX = "0123456789abcdefghijklmnopqrstuv";

/** Our own event id (Google allows base32hex, 5–1024 chars), so a retried insert cannot duplicate. */
export function newEventId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  let out = "";
  for (const b of bytes) out += BASE32HEX[b & 31];
  return `uc${out}`;
}

type EventBooking = {
  id: number; start_utc: string; end_utc: string; state: string; customer_tz: string; conversation_id: number | null;
  gcal_event_id: string | null; meet_url: string | null; name: string | null; email: string;
};

function eventBody(env: GoogleEnv, b: EventBooking, hostTz: string) {
  return {
    summary: `Durum Analizi — ${b.name ?? b.email}`,
    description: [
      `Müşteri: ${b.name ? `${b.name} <${b.email}>` : b.email}`,
      `Müşterinin saat dilimi: ${b.customer_tz}`,
      ...(b.conversation_id ? [`Konuşma: ${env.APP_URL}/admin/konusma/${b.conversation_id}`] : []),
      "",
      "Müşteri bu etkinliğe davetli değil; Meet bağlantısı ona Üç Eksen e-postasıyla gitti. Katılmak istediğinde içeri al.",
    ].join("\n"),
    start: { dateTime: b.start_utc, timeZone: hostTz },
    end: { dateTime: b.end_utc, timeZone: hostTz },
    status: "confirmed",
    transparency: "opaque",
    visibility: "private",
    guestsCanInviteOthers: false,
    extendedProperties: { private: { uceksenBookingId: String(b.id), uceksenEnvironment: env.ENVIRONMENT } },
  };
}

const meetOf = (ev: any): string | null => // eslint-disable-line @typescript-eslint/no-explicit-any
  ev?.hangoutLink ?? ev?.conferenceData?.entryPoints?.find((e: { entryPointType: string; uri: string }) => e.entryPointType === "video")?.uri ?? null;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type SyncResult = { status: "synced" | "failed" | "skipped"; meetUrl: string | null; error?: string };

/**
 * Brings the booking's Google event in line with the booking row: creates it (with a Meet
 * link) or moves it while the booking is live, deletes it once cancelled. Idempotent, so
 * it also serves as the retry. Never throws; failures are recorded on the booking.
 */
export async function syncBookingEvent(env: GoogleEnv, bookingId: number): Promise<SyncResult> {
  const load = () =>
    env.DB.prepare(
      `SELECT b.id, b.start_utc, b.end_utc, b.state, b.customer_tz, b.conversation_id, b.gcal_event_id, b.meet_url, ct.name, ct.email
         FROM bookings b JOIN contacts ct ON ct.id = b.contact_id WHERE b.id = ?1`,
    ).bind(bookingId).first<EventBooking>();
  const b = await load();
  if (!b) return { status: "skipped", meetUrl: null };
  const s = await getGoogleSettings(env.DB);
  if (!s.refreshEnc || !s.calendarId) return { status: "skipped", meetUrl: b.meet_url };
  const live = b.state === "confirmed" || b.state === "rescheduled";
  if (!live && !b.gcal_event_id) return { status: "skipped", meetUrl: b.meet_url };

  const cal = `/calendars/${encodeURIComponent(s.calendarId)}/events`;
  try {
    let meet = b.meet_url;
    if (live) {
      let eventId = b.gcal_event_id;
      if (!eventId) {
        await env.DB.prepare("UPDATE bookings SET gcal_event_id = ?1 WHERE id = ?2 AND gcal_event_id IS NULL").bind(newEventId(), b.id).run();
        eventId = (await load())!.gcal_event_id!;
      }
      const q = "?conferenceDataVersion=1&sendUpdates=none";
      const body = eventBody(env, b, await getHostTz(env.DB));
      const meetRequest = (requestId: string) => ({ createRequest: { requestId, conferenceSolutionKey: { type: "hangoutsMeet" } } });
      let r = await api(env, s, "POST", cal + q, { ...body, id: eventId, conferenceData: meetRequest(eventId) });
      // 409: the event exists (earlier attempt, or deleted by hand: patching restores it).
      if (r.status === 409) r = await api(env, s, "PATCH", `${cal}/${eventId}${q}`, body);
      if (r.status !== 200) throw failure("event", r);
      let ev = r.data;
      if (!meetOf(ev) && ev?.conferenceData?.createRequest?.status?.statusCode !== "pending") {
        r = await api(env, s, "PATCH", `${cal}/${eventId}${q}`, { conferenceData: meetRequest(`${eventId}${Date.now().toString(32)}`) });
        if (r.status !== 200) throw failure("meet", r);
        ev = r.data;
      }
      for (let i = 0; i < 3 && !meetOf(ev); i++) {
        await sleep(800);
        r = await api(env, s, "GET", `${cal}/${eventId}`);
        if (r.status === 200) ev = r.data;
      }
      meet = meetOf(ev) ?? meet;
      if (!meet) throw new GoogleError("Meet bağlantısı oluşmadı");
    } else {
      const r = await api(env, s, "DELETE", `${cal}/${b.gcal_event_id}?sendUpdates=none`);
      if (![200, 204, 404, 410].includes(r.status)) throw failure("delete", r);
    }
    await env.DB.prepare("UPDATE bookings SET meet_url = ?1, gcal_status = 'synced', gcal_error = NULL WHERE id = ?2").bind(meet, b.id).run();
    return { status: "synced", meetUrl: meet };
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    console.error("google sync", bookingId, msg);
    await env.DB.prepare("UPDATE bookings SET gcal_status = 'failed', gcal_error = ?1 WHERE id = ?2").bind(msg, b.id).run();
    return { status: "failed", meetUrl: b.meet_url, error: msg };
  }
}

/** Plain-Turkish reason for an admin, from any Google failure. */
export function googleProblem(err: unknown): string {
  if (err instanceof GoogleError && err.code === "invalid_grant") return "Google izni geçersiz (geri alınmış olabilir). Takvim sayfasından yeniden bağlan.";
  if (err instanceof GoogleError && err.code === "calendar") return `Takvimlerden biri okunamadı: ${err.message}`;
  return `Google Takvim'e ulaşılamadı: ${err instanceof Error ? err.message : String(err)}`;
}
