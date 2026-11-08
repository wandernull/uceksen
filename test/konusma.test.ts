import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { fake } from "./fake-resend";
import { freshIp, messages, newConversation } from "./helpers";

function reply(token: string, fields: Record<string, string | File | File[]>, headers: Record<string, string> = {}) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) fd.append(k, x);
  return SELF.fetch(`https://example.com/konusma/${token}`, {
    method: "POST",
    body: fd,
    redirect: "manual",
    headers: { origin: "https://example.com", "cf-connecting-ip": freshIp(), ...headers },
  });
}

describe("/konusma/{token}", () => {
  beforeEach(() => fake.reset());

  it("shows the thread privately: no-store, noindex, no referrer", async () => {
    const conv = await newConversation("sayfa@example.com", "İki ülkede gelirim var.");
    const res = await SELF.fetch(`https://example.com/konusma/${conv.reply_token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
    const html = await res.text();
    expect(html).toContain('<meta name="robots" content="noindex, nofollow"');
    expect(html).toContain("İki ülkede gelirim var.");
    expect(html).toContain("Talebin bize ulaştı"); // the acknowledgement
    expect(html).toContain('enctype="multipart/form-data"');
  });

  it("hides outgoing messages that failed to send", async () => {
    fake.failSends = true;
    const conv = await newConversation("gizli@example.com");
    const html = await (await SELF.fetch(`https://example.com/konusma/${conv.reply_token}`)).text();
    expect(html).not.toContain("Talebin bize ulaştı. İki iş günü");
  });

  it("404s for unknown or malformed tokens", async () => {
    expect((await SELF.fetch("https://example.com/konusma/" + "a".repeat(32))).status).toBe(404);
    expect((await SELF.fetch("https://example.com/konusma/short")).status).toBe(404);
  });

  it("stores a web reply, sets state to ours and notifies admins", async () => {
    const conv = await newConversation("web@example.com");
    fake.reset();
    const res = await reply(conv.reply_token, { metin: "Bir sorum daha var." });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/konusma/${conv.reply_token}?gonderildi=1#yanit`);
    const last = (await messages(conv.id)).at(-1)!;
    expect(last).toMatchObject({ direction: "in", via: "web", body_text: "Bir sorum daha var.", author: "customer" });
    const state = await env.DB.prepare("SELECT state FROM conversations WHERE id = ?1").bind(conv.id).first<{ state: string }>();
    expect(state!.state).toBe("ours");
    expect(fake.sent.map((s) => s.subject)).toEqual([expect.stringContaining("Yeni yanıt (web)")]);
  });

  it("accepts attachments, downloadable only through the same token", async () => {
    const a = await newConversation("dosya@example.com");
    const b = await newConversation("baska@example.com");
    const res = await reply(a.reply_token, { metin: "", dosya: new File(["%PDF-1.4"], "Gelir tablosu.pdf", { type: "application/pdf" }) });
    expect(res.status).toBe(303);
    const att = await env.DB.prepare(
      "SELECT a.id FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.conversation_id = ?1",
    ).bind(a.id).first<{ id: number }>();
    const own = await SELF.fetch(`https://example.com/konusma/${a.reply_token}/ek/${att!.id}`);
    expect(own.status).toBe(200);
    expect(own.headers.get("content-disposition")).toContain("attachment");
    expect(await own.text()).toBe("%PDF-1.4");
    expect((await SELF.fetch(`https://example.com/konusma/${b.reply_token}/ek/${att!.id}`)).status).toBe(404);
  });

  it("rejects empty replies, disallowed file types, too many files", async () => {
    const conv = await newConversation("red@example.com");
    const n = (await messages(conv.id)).length;
    expect((await reply(conv.reply_token, { metin: "  " })).status).toBe(400);
    const exe = await reply(conv.reply_token, { metin: "x", dosya: new File(["MZ"], "setup.exe") });
    expect(exe.status).toBe(400);
    expect(await exe.text()).toContain("setup.exe");
    const many = Array.from({ length: 6 }, (_, i) => new File(["x"], `f${i}.txt`));
    expect((await reply(conv.reply_token, { metin: "x", dosya: many })).status).toBe(400);
    expect(await messages(conv.id)).toHaveLength(n);
  });

  it("honeypot: pretends success, stores nothing", async () => {
    const conv = await newConversation("bot@example.com");
    const n = (await messages(conv.id)).length;
    expect((await reply(conv.reply_token, { metin: "spam", website: "http://spam" })).status).toBe(303);
    expect(await messages(conv.id)).toHaveLength(n);
  });

  it("rejects cross-site posts (CSRF)", async () => {
    const conv = await newConversation("csrf@example.com");
    const res = await reply(conv.reply_token, { metin: "x" }, { origin: "https://evil.example" });
    expect(res.status).toBe(403);
  });

  it("rate-limits replies per IP", async () => {
    const conv = await newConversation("rate@example.com");
    const ip = "198.18.0.77";
    const statuses = [];
    for (let i = 0; i < 11; i++) statuses.push((await reply(conv.reply_token, { metin: `m${i}` }, { "cf-connecting-ip": ip })).status);
    expect(statuses.slice(0, 10).every((s) => s === 303)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});
