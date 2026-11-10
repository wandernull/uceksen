import { googleApi, SCOPES } from "../src/lib/google";

type Ev = Record<string, unknown> & { id: string; status: string };
type Call = { method: string; path: string; query: URLSearchParams; body: any }; // eslint-disable-line @typescript-eslint/no-explicit-any

/** In-memory stand-in for Google OAuth + Calendar. Installed for every test file (see vitest.config.ts). */
export const fakeGoogle = {
  calls: [] as Call[],
  tokenRequests: [] as URLSearchParams[],
  revoked: [] as string[],
  grantedScopes: SCOPES.join(" "),
  giveRefreshToken: true,
  /** Refresh token no longer valid (user revoked access in their Google account). */
  invalidGrant: false,
  calendars: [] as { id: string; summary: string; primary?: boolean; accessRole: string }[],
  busy: new Map<string, { start: string; end: string }[]>(),
  /** Calendar ids that freebusy reports an error for (e.g. sharing removed). */
  busyErrors: new Set<string>(),
  failFreeBusy: false,
  failEvents: false,
  events: new Map<string, Ev>(),
  seq: 0,
  reset() {
    this.calls = [];
    this.tokenRequests = [];
    this.revoked = [];
    this.grantedScopes = SCOPES.join(" ");
    this.giveRefreshToken = true;
    this.invalidGrant = false;
    this.calendars = [
      { id: "gizem@example.com", summary: "gizem@example.com", primary: true, accessRole: "owner" },
      { id: "uc-eksen-cal@group.calendar.google.com", summary: "Üç Eksen", accessRole: "owner" },
      { id: "baran@example.com", summary: "Baran", accessRole: "freeBusyReader" },
      { id: "tr.turkish#holiday@group.v.calendar.google.com", summary: "Türkiye'deki Tatiller", accessRole: "reader" },
    ];
    this.busy.clear();
    this.busyErrors.clear();
    this.failFreeBusy = false;
    this.failEvents = false;
    this.events.clear();
  },
  eventCalls(method?: string) {
    return this.calls.filter((c) => c.path.includes("/events") && (!method || c.method === method));
  },
};
fakeGoogle.reset();

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const meet = (ev: Ev) => {
  const link = `https://meet.google.com/abc-${++fakeGoogle.seq}`;
  ev.hangoutLink = link;
  ev.conferenceData = { entryPoints: [{ entryPointType: "video", uri: link }], conferenceSolution: { key: { type: "hangoutsMeet" } } };
};

googleApi.fetch = async (url: string, init?: RequestInit) => {
  const u = new URL(url);
  const method = init?.method ?? "GET";
  if (u.href === "https://oauth2.googleapis.com/token") {
    const p = new URLSearchParams(String(init?.body));
    fakeGoogle.tokenRequests.push(p);
    if (p.get("client_secret") !== "test-google-secret") return json({ error: "invalid_client" }, 401);
    if (p.get("grant_type") === "authorization_code") {
      if (p.get("code") !== "good-code" || !p.get("code_verifier")) return json({ error: "invalid_grant" }, 400);
      return json({
        access_token: `at-${++fakeGoogle.seq}`, expires_in: 3599, scope: fakeGoogle.grantedScopes, token_type: "Bearer",
        ...(fakeGoogle.giveRefreshToken ? { refresh_token: "rt-secret-refresh-token" } : {}),
      });
    }
    if (p.get("grant_type") === "refresh_token") {
      if (fakeGoogle.invalidGrant || p.get("refresh_token") !== "rt-secret-refresh-token") return json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400);
      return json({ access_token: `at-${++fakeGoogle.seq}`, expires_in: 3599, scope: fakeGoogle.grantedScopes, token_type: "Bearer" });
    }
    return json({ error: "unsupported_grant_type" }, 400);
  }
  if (u.href === "https://oauth2.googleapis.com/revoke") {
    fakeGoogle.revoked.push(new URLSearchParams(String(init?.body)).get("token") ?? "");
    return new Response("", { status: 200 });
  }
  if (u.hostname !== "www.googleapis.com" || !u.pathname.startsWith("/calendar/v3/")) throw new Error(`unexpected fetch ${url}`);
  if (!new Headers(init?.headers).get("authorization")?.startsWith("Bearer at-")) return json({ error: { message: "unauthenticated" } }, 401);
  const path = u.pathname.slice("/calendar/v3".length);
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  fakeGoogle.calls.push({ method, path, query: u.searchParams, body });

  if (method === "GET" && path === "/users/me/calendarList") return json({ items: fakeGoogle.calendars });
  if (method === "POST" && path === "/freeBusy") {
    if (fakeGoogle.failFreeBusy) return json({ error: { message: "backend error" } }, 503);
    const from = Date.parse(body.timeMin);
    const to = Date.parse(body.timeMax);
    const calendars: Record<string, unknown> = {};
    for (const { id } of body.items as { id: string }[]) {
      calendars[id] = fakeGoogle.busyErrors.has(id)
        ? { errors: [{ domain: "global", reason: "notFound" }], busy: [] }
        : { busy: (fakeGoogle.busy.get(id) ?? []).filter((b) => Date.parse(b.end) > from && Date.parse(b.start) < to) };
    }
    return json({ kind: "calendar#freeBusy", calendars });
  }
  const m = path.match(/^\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/);
  if (m) {
    if (fakeGoogle.failEvents) return json({ error: { message: "backend error" } }, 503);
    const id = m[2] ? decodeURIComponent(m[2]) : undefined;
    if (method === "POST" && !id) {
      const existing = fakeGoogle.events.get(body.id);
      if (existing) return json({ error: { message: "The requested identifier already exists." } }, 409);
      const ev: Ev = { ...body, status: body.status ?? "confirmed", calendarId: decodeURIComponent(m[1]!) };
      if (body.conferenceData?.createRequest) meet(ev);
      fakeGoogle.events.set(ev.id, ev);
      return json(ev);
    }
    const ev = id ? fakeGoogle.events.get(id) : undefined;
    if (!ev) return json({ error: { message: "Not Found" } }, 404);
    if (method === "GET") return json(ev);
    if (method === "PATCH") {
      Object.assign(ev, body);
      if (body.conferenceData?.createRequest && !ev.hangoutLink) meet(ev);
      return json(ev);
    }
    if (method === "DELETE") {
      if (ev.status === "cancelled") return json({ error: { message: "Resource has been deleted" } }, 410);
      ev.status = "cancelled";
      return new Response(null, { status: 204 });
    }
  }
  throw new Error(`unexpected Google call ${method} ${path}`);
};
