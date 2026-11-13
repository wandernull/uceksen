import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sendOutgoing } from "../src/lib/conversations";
import { signWebhook, TOLERANCE_SEC, verifyWebhook } from "../src/lib/webhook-signature";
import { fake, sentMessageId } from "./fake-resend";
import { messages, newConversation, postWebhook } from "./helpers";

const SECRET = env.RESEND_INBOUND_SECRET;

describe("webhook signature (Svix scheme)", () => {
  const now = 1_800_000_000;
  const ts = String(now);
  const body = '{"type":"email.received"}';

  it("accepts a valid signature, also among several (key rotation)", async () => {
    const sig = await signWebhook(SECRET, "id1", ts, body);
    expect(await verifyWebhook(SECRET, { id: "id1", timestamp: ts, signature: `v1,${sig}` }, body, now)).toBe(true);
    expect(await verifyWebhook(SECRET, { id: "id1", timestamp: ts, signature: `v1,AAAA v1,${sig}` }, body, now)).toBe(true);
  });
  it("rejects wrong secret, tampered body, other id, unknown version", async () => {
    const sig = await signWebhook(SECRET, "id1", ts, body);
    const other = await signWebhook("whsec_" + btoa("another-secret-another-secret!!"), "id1", ts, body);
    expect(await verifyWebhook(SECRET, { id: "id1", timestamp: ts, signature: `v1,${other}` }, body, now)).toBe(false);
    expect(await verifyWebhook(SECRET, { id: "id1", timestamp: ts, signature: `v1,${sig}` }, body + " ", now)).toBe(false);
    expect(await verifyWebhook(SECRET, { id: "id2", timestamp: ts, signature: `v1,${sig}` }, body, now)).toBe(false);
    expect(await verifyWebhook(SECRET, { id: "id1", timestamp: ts, signature: `v2,${sig}` }, body, now)).toBe(false);
  });
  it("rejects stale or future timestamps (replay)", async () => {
    for (const t of [now - TOLERANCE_SEC - 1, now + TOLERANCE_SEC + 1]) {
      const sig = await signWebhook(SECRET, "id1", String(t), body);
      expect(await verifyWebhook(SECRET, { id: "id1", timestamp: String(t), signature: `v1,${sig}` }, body, now)).toBe(false);
    }
  });
  it("rejects missing headers or a missing secret", async () => {
    const sig = await signWebhook(SECRET, "id1", ts, body);
    expect(await verifyWebhook(SECRET, { id: undefined, timestamp: ts, signature: `v1,${sig}` }, body, now)).toBe(false);
    expect(await verifyWebhook(SECRET, { id: "id1", timestamp: ts, signature: undefined }, body, now)).toBe(false);
    expect(await verifyWebhook(undefined, { id: "id1", timestamp: ts, signature: `v1,${sig}` }, body, now)).toBe(false);
    expect(await verifyWebhook("", { id: "id1", timestamp: ts, signature: `v1,${sig}` }, body, now)).toBe(false);
  });
});

function inbound(id: string, over: Partial<Record<string, unknown>> = {}) {
  const e = {
    id,
    from: '"Ayşe Yılmaz" <ayse@example.com>',
    to: ["merhaba+x@reply.uceksen.com"],
    subject: "Re: Durum Analizi talebi — Üç Eksen",
    message_id: `<${id}@mail.gmail.com>`,
    text: "Salı uygun.\n\nOn Sat, Nov 7, 2026 at 10:15 PM Üç Eksen <merhaba@uceksen.com> wrote:\n> Merhaba",
    html: null,
    headers: {},
    attachments: [],
    ...over,
  };
  fake.received.set(id, e as never);
  return { type: "email.received", data: { email_id: id } };
}

describe("POST /api/webhooks/resend", () => {
  beforeEach(() => fake.reset());

  it("rejects unsigned or tampered requests and stores nothing", async () => {
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages").first<{ n: number }>();
    const plain = await SELF.fetch("https://example.com/api/webhooks/resend", { method: "POST", body: JSON.stringify(inbound("u1")) });
    expect(plain.status).toBe(401);
    expect((await postWebhook(inbound("u2"), { tamper: true })).status).toBe(401);
    expect((await postWebhook(inbound("u3"), { secret: "whsec_" + btoa("wrong-secret-wrong-secret-wrong!") })).status).toBe(401);
    expect((await postWebhook(inbound("u4"), { timestamp: Math.floor(Date.now() / 1000) - 3600 })).status).toBe(401);
    const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages").first<{ n: number }>();
    expect(after!.n).toBe(before!.n);
  });

  it("threads a reply by In-Reply-To, strips the quote, keeps the raw body, notifies admins", async () => {
    const conv = await newConversation("thread1@example.com");
    const ack = (await messages(conv.id)).find((m) => m.direction === "out")!;
    expect(ack.provider_message_id).toBe(sentMessageId(String(ack.resend_id)));
    fake.reset();

    const res = await postWebhook(inbound("in1", { to: ["merhaba@reply.uceksen.com"], headers: { "in-reply-to": ack.provider_message_id } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ matched: true });

    const last = (await messages(conv.id)).at(-1)!;
    expect(last).toMatchObject({ direction: "in", author: "customer", via: "email", body_text: "Salı uygun.", from_addr: "ayse@example.com", provider_message_id: "<in1@mail.gmail.com>" });
    expect(String(last.body_raw)).toContain("> Merhaba");
    const state = await env.DB.prepare("SELECT state FROM conversations WHERE id = ?1").bind(conv.id).first<{ state: string }>();
    expect(state!.state).toBe("ours");
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]!.subject).toContain("Yeni yanıt (e-posta)");
    expect(fake.sent[0]!.to).toEqual(["dev@example.com"]);
  });

  it("matches by In-Reply-To even when the sent Message-ID was not known yet", async () => {
    const conv = await newConversation("late-id@example.com");
    const ack = (await messages(conv.id)).find((m) => m.direction === "out")!;
    await env.DB.prepare("UPDATE messages SET provider_message_id = NULL WHERE id = ?1").bind(ack.id).run();
    const res = await postWebhook(inbound("in9", { to: ["merhaba@reply.uceksen.com"], headers: { "in-reply-to": sentMessageId(String(ack.resend_id)) } }));
    expect(await res.json()).toMatchObject({ matched: true });
    expect((await messages(conv.id)).find((m) => m.id === ack.id)!.provider_message_id).toBe(sentMessageId(String(ack.resend_id)));
  });

  it("falls back to the plus token in To (any case), reading References as Resend sends them", async () => {
    const conv = await newConversation("thread2@example.com");
    const res = await postWebhook(
      inbound("in2", { to: [`Üç Eksen <MERHABA+${conv.plus_token.toUpperCase()}@reply.uceksen.com>`], headers: { references: '["<unknown@x>"]' } }),
    );
    expect(await res.json()).toMatchObject({ matched: true });
    expect((await messages(conv.id)).at(-1)!.body_text).toBe("Salı uygun.");
  });

  it("stores unmatched email and notifies admins", async () => {
    const res = await postWebhook(inbound("in3", { to: ["merhaba@reply.uceksen.com"], subject: "Merhaba" }));
    expect(await res.json()).toMatchObject({ matched: false });
    const row = await env.DB.prepare("SELECT * FROM unmatched_emails WHERE provider_message_id = ?1").bind("<in3@mail.gmail.com>").first<Record<string, unknown>>();
    expect(row).toMatchObject({ from_addr: "ayse@example.com", subject: "Merhaba", body_text: "Salı uygun." });
    expect(String(row!.raw_json)).toContain("raw_text");
    expect(fake.sent[0]!.subject).toContain("Eşleşmeyen e-posta");
  });

  it("ignores a redelivered email (webhook retry)", async () => {
    const conv = await newConversation("dup@example.com");
    const ev = inbound("in4", { to: [`merhaba+${conv.plus_token}@reply.uceksen.com`] });
    await postWebhook(ev);
    const res = await postWebhook(ev);
    expect(await res.json()).toMatchObject({ duplicate: true });
    expect((await messages(conv.id)).filter((m) => m.direction === "in")).toHaveLength(2); // form + one reply

    const un = inbound("in5", { to: ["merhaba@reply.uceksen.com"] });
    await postWebhook(un);
    await postWebhook(un);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM unmatched_emails WHERE provider_message_id = '<in5@mail.gmail.com>'").first<{ n: number }>();
    expect(n!.n).toBe(1);
  });

  it("uses the HTML part when there is no text part", async () => {
    const conv = await newConversation("html@example.com");
    await postWebhook(
      inbound("in6", {
        to: [`merhaba+${conv.plus_token}@reply.uceksen.com`],
        text: null,
        html: '<div>Perşembe &amp; Cuma olur</div><div class="gmail_quote">eski</div>',
      }),
    );
    expect((await messages(conv.id)).at(-1)!.body_text).toBe("Perşembe & Cuma olur");
  });

  it("stores email attachments in R2", async () => {
    const conv = await newConversation("att@example.com");
    fake.attachments.set("in7", [{ id: "a1", filename: "pasaport.pdf", content_type: "application/pdf", size: 4, download_url: "https://files.test/a1" }]);
    fake.downloads.set("/a1", new Uint8Array([37, 80, 68, 70]));
    await postWebhook(inbound("in7", { to: [`merhaba+${conv.plus_token}@reply.uceksen.com`], attachments: [{ id: "a1", filename: "pasaport.pdf", content_type: "application/pdf", size: 4 }] }));
    const msg = (await messages(conv.id)).at(-1)!;
    const att = await env.DB.prepare("SELECT * FROM attachments WHERE message_id = ?1").bind(msg.id).first<{ r2_key: string; filename: string }>();
    expect(att!.filename).toBe("pasaport.pdf");
    const obj = await env.BUCKET.get(att!.r2_key);
    expect(new Uint8Array(await obj!.arrayBuffer())).toEqual(new Uint8Array([37, 80, 68, 70]));
  });

  it("ignores mail for the other environment: nothing stored, nobody notified", async () => {
    const conv = await newConversation("other@example.com");
    fake.reset();
    for (const [id, to] of [["in10", `staging+${conv.plus_token}@reply.uceksen.com`], ["in11", "nobody@reply.uceksen.com"]] as const) {
      const res = await postWebhook(inbound(id, { to: [to] }));
      expect(await res.json()).toMatchObject({ ok: true, ignored: "other-environment" });
    }
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM unmatched_emails WHERE provider_message_id IN ('<in10@mail.gmail.com>','<in11@mail.gmail.com>')").first<{ n: number }>();
    expect(n!.n).toBe(0);
    expect((await messages(conv.id)).filter((m) => m.direction === "in")).toHaveLength(1); // the form only
    expect(fake.sent).toHaveLength(0);
  });

  it("acknowledges other event types without doing anything", async () => {
    const res = await postWebhook({ type: "email.delivered", data: { email_id: "x" } });
    expect(await res.json()).toMatchObject({ ignored: true });
  });

  it("a later admin reply threads onto the customer's email", async () => {
    const conv = await newConversation("thread3@example.com");
    await postWebhook(inbound("in8", { to: [`merhaba+${conv.plus_token}@reply.uceksen.com`] }));
    fake.reset();
    await sendOutgoing(env, conv.id, "gizem", "Salı 14:00'te görüşelim.", { via: "admin", nextState: "theirs" });
    const s = fake.sent[0]!;
    expect(s.headers!["In-Reply-To"]).toBe("<in8@mail.gmail.com>");
    expect(s.headers!["References"]!.split(" ")).toHaveLength(2); // ack + customer reply
    expect(s.subject).toBe("[TEST] Re: Durum Analizi talebi — Üç Eksen");
    expect(s.text).toContain("Salı 14:00'te görüşelim.\n\nGizem\nÜç Eksen");
    expect(s.text).toContain(`/konusma/${conv.reply_token}`);
    expect(s.reply_to).toBe(`merhaba+${conv.plus_token}@reply.uceksen.com`);
  });
});
