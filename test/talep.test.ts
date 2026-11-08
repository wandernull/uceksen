import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { RATE } from "../src/routes/talep";

let ipSeq = 0;
const freshIp = () => `203.0.113.${++ipSeq}`;

function post(body: Record<string, unknown>, ip = freshIp()) {
  return SELF.fetch("https://example.com/api/talep", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify(body),
  });
}

const valid = (email: string, extra: Record<string, unknown> = {}) => ({
  ad: "Ayşe Yılmaz",
  email,
  telefon: "+31 6 1234 5678",
  durum: "Hollanda'da şirketim var,\nİspanya'ya oturum düşünüyorum.",
  onay: "on",
  kaynak: "danismanlik",
  website: "",
  ...extra,
});

async function rowsFor(email: string) {
  const contact = await env.DB.prepare("SELECT * FROM contacts WHERE email = ?").bind(email).first<Record<string, unknown>>();
  const convs = await env.DB.prepare(
    "SELECT c.* FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE ct.email = ? ORDER BY c.id",
  ).bind(email).all<Record<string, unknown>>();
  const msgs = await env.DB.prepare(
    "SELECT m.* FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN contacts ct ON ct.id = c.contact_id WHERE ct.email = ? ORDER BY m.id",
  ).bind(email).all<Record<string, unknown>>();
  return { contact, convs: convs.results, msgs: msgs.results };
}

describe("POST /api/talep", () => {
  it("stores contact, conversation and first message", async () => {
    const res = await post(valid("Ayse@Example.com"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const { contact, convs, msgs } = await rowsFor("ayse@example.com");
    expect(contact).toMatchObject({ email: "ayse@example.com", name: "Ayşe Yılmaz", phone: "+31 6 1234 5678" });
    expect(convs).toHaveLength(1);
    const conv = convs[0]!;
    expect(conv).toMatchObject({ state: "new", subject: "Durum Analizi talebi", source: "danismanlik" });
    expect(conv.consent_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(String(conv.last_message_at) >= String(conv.created_at)).toBe(true); // the acknowledgement moves it on
    expect(conv.reply_token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(conv.plus_token).toMatch(/^[a-z2-7]{32}$/); // lower-case: survives mail systems changing case
    expect(conv.reply_token).not.toBe(conv.plus_token);
    expect(msgs).toHaveLength(2); // customer's message + our acknowledgement
    expect(msgs[1]).toMatchObject({ direction: "out", author: "system" });
    expect(msgs[0]).toMatchObject({ direction: "in", author: "customer", via: "form", body_text: "Hollanda'da şirketim var,\nİspanya'ya oturum düşünüyorum." });
  });

  it("honeypot filled: 200, nothing stored", async () => {
    const res = await post(valid("bot@example.com", { website: "http://spam.example" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const { contact, convs } = await rowsFor("bot@example.com");
    expect(contact).toBeNull();
    expect(convs).toHaveLength(0);
  });

  it("same email twice: one contact, two conversations, contact updated", async () => {
    await post(valid("tekrar@example.com", { kaynak: "hakkimizda" }));
    await post(valid("tekrar@example.com", { ad: "Ayşe Y.", telefon: "" }));
    const { contact, convs } = await rowsFor("tekrar@example.com");
    expect(contact).toMatchObject({ name: "Ayşe Y.", phone: "+31 6 1234 5678" }); // empty phone keeps the old one
    expect(convs.map((c) => c.subject)).toEqual(["İletişim formu", "Durum Analizi talebi"]);
  });

  it.each([
    [{ ad: "" }, "Ad soyad gerekli."],
    [{ email: "not-an-email" }, "Geçerli bir e-posta adresi yaz."],
    [{ durum: "   " }, "Durum özeti gerekli."],
    [{ durum: "x".repeat(5001) }, "Durum özeti çok uzun; en fazla 5000 karakter yazabilirsin."],
    [{ onay: undefined }, "Devam etmek için onay kutusunu işaretle."],
  ])("rejects invalid input %#", async (patch, message) => {
    const email = `invalid${Math.random().toString(36).slice(2)}@example.com`;
    const res = await post(valid(email, patch));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: message });
    expect((await rowsFor(email)).convs).toHaveLength(0);
  });

  it(`rate limits to ${RATE.limit} per hour per IP`, async () => {
    const ip = freshIp();
    for (let i = 0; i < RATE.limit; i++) {
      expect((await post(valid(`rl${i}@example.com`), ip)).status).toBe(200);
    }
    const blocked = await post(valid("rl-over@example.com"), ip);
    expect(blocked.status).toBe(429);
    expect((await blocked.json()) as object).toMatchObject({ ok: false });
    expect((await rowsFor("rl-over@example.com")).convs).toHaveLength(0);
    // Another IP is unaffected.
    expect((await post(valid("rl-other@example.com"))).status).toBe(200);
  });

  it("native form post (no JS) gets a Turkish HTML page", async () => {
    const form = new URLSearchParams({ ad: "Mehmet", email: "nojs@example.com", durum: "Merhaba", onay: "on", kaynak: "hakkimizda", website: "" });
    const res = await SELF.fetch("https://example.com/api/talep", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": freshIp(), referer: "https://example.com/hakkimizda" },
      body: form,
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Talebin bize ulaştı");
    expect(html).toContain('href="/hakkimizda"');
    expect((await rowsFor("nojs@example.com")).convs).toHaveLength(1);
  });

  it("pages carry the honeypot, error slot and shared script", async () => {
    for (const path of ["/danismanlik", "/hakkimizda"]) {
      const html = await (await SELF.fetch(`https://example.com${path}`)).text();
      expect(html).toContain('name="website"');
      expect(html).toContain('id="talepHata"');
      expect(html).toContain('<script src="/talep.js" defer></script>');
      expect(html).toContain('action="/api/talep"');
    }
  });
});
