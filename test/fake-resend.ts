import { resendApi, type ReceivedEmail } from "../src/lib/mail";

/** In-memory stand-in for the Resend API. Installed for every test file (see vitest.config.ts). */
export type SentCall = {
  to: string[]; subject: string; text: string; reply_to?: string; headers?: Record<string, string>; from: string;
};

export const fake = {
  sent: [] as SentCall[],
  received: new Map<string, ReceivedEmail>(),
  attachments: new Map<string, { id: string; filename: string; content_type: string; size: number; download_url: string }[]>(),
  downloads: new Map<string, Uint8Array>(),
  failSends: false,
  seq: 0,
  reset() {
    this.sent = [];
    this.received.clear();
    this.attachments.clear();
    this.downloads.clear();
    this.failSends = false;
  },
};

/** Message-ID the fake "SES" assigns to a sent email. */
export const sentMessageId = (resendId: string) => `<${resendId}@eu-west-1.amazonses.com>`;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

resendApi.fetch = async (url: string, init?: RequestInit) => {
  const u = new URL(url);
  const method = init?.method ?? "GET";
  if (u.hostname === "files.test") {
    const bytes = fake.downloads.get(u.pathname);
    return bytes ? new Response(bytes) : new Response("nope", { status: 404 });
  }
  if (u.hostname !== "api.resend.com") throw new Error(`unexpected fetch ${url}`);

  if (method === "POST" && u.pathname === "/emails") {
    if (fake.failSends) return json({ message: "boom" }, 500);
    fake.sent.push(JSON.parse(String(init?.body)));
    return json({ id: `re_${++fake.seq}` });
  }
  let m = u.pathname.match(/^\/emails\/receiving\/([^/]+)\/attachments$/);
  if (m) return json({ data: fake.attachments.get(decodeURIComponent(m[1]!)) ?? [] });
  m = u.pathname.match(/^\/emails\/receiving\/([^/]+)$/);
  if (m) {
    const e = fake.received.get(decodeURIComponent(m[1]!));
    return e ? json(e) : json({ message: "not found" }, 404);
  }
  m = u.pathname.match(/^\/emails\/([^/]+)$/);
  if (m) return json({ id: m[1], message_id: sentMessageId(decodeURIComponent(m[1]!)) });
  throw new Error(`unexpected Resend call ${method} ${u.pathname}`);
};
