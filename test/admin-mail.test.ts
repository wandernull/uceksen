import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { fake } from "./fake-resend";
import { messages, newConversation, postWebhook } from "./helpers";

const form = (path: string, body: string) =>
  SELF.fetch(`https://example.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://example.com" },
    body,
    redirect: "manual",
  });

describe("contact form emails", () => {
  beforeEach(() => fake.reset());

  it("sends the customer an acknowledgement quoting the form, and one admin notification — both to DEV_EMAIL", async () => {
    const conv = await newConversation("ack@example.com", "Hollanda'da şirketim var.\nİspanya düşünüyorum.", "Zeynep Kaya");
    expect(fake.sent).toHaveLength(2);
    const [ack, note] = fake.sent;
    expect(ack!.to).toEqual(["dev@example.com"]);
    expect(ack!.text).toContain("asıl alıcı: ack@example.com");
    expect(ack!.subject).toBe("[TEST] Durum Analizi talebi — Üç Eksen");
    expect(ack!.text).toContain("Merhaba Zeynep Kaya,");
    expect(ack!.text).toContain("> Hollanda'da şirketim var.\n> İspanya düşünüyorum.");
    expect(ack!.reply_to).toBe(`merhaba+${conv.plus_token}@reply.uceksen.com`);
    expect(ack!.headers).toBeUndefined(); // first message of the thread
    expect(note!.to).toEqual(["dev@example.com"]);
    expect(note!.text).toContain("asıl alıcı: gizem@example.com, baran@example.com");
    expect(note!.text).toContain(`/admin/konusma/${conv.id}`);
    expect(conv.plus_token).toMatch(/^[a-z2-7]{32}$/);

    const ackRow = (await messages(conv.id)).find((m) => m.direction === "out")!;
    expect(ackRow).toMatchObject({ author: "system", via: "form", send_status: "sent" });
  });

  it("still accepts the request when Resend is down; the acknowledgement is marked failed", async () => {
    fake.failSends = true;
    const conv = await newConversation("down@example.com");
    const ack = (await messages(conv.id)).find((m) => m.direction === "out")!;
    expect(ack.send_status).toBe("failed");
    expect(String(ack.send_error)).toContain("500");
  });
});

describe("/admin replies", () => {
  beforeEach(() => fake.reset());

  it("sends the reply with the admin's signature and sets state to theirs", async () => {
    const conv = await newConversation("yanit@example.com");
    fake.reset();
    const res = await form(`/admin/konusma/${conv.id}/yanit`, "metin=" + encodeURIComponent("Merhaba,\nuygunuz."));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/admin/konusma/${conv.id}?gonderildi=1#yanit`);
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]!.text).toContain("Merhaba,\nuygunuz.\n\nGizem\nÜç Eksen");
    expect(fake.sent[0]!.headers!["In-Reply-To"]).toBeTruthy(); // threads onto the acknowledgement
    const last = (await messages(conv.id)).at(-1)!;
    expect(last).toMatchObject({ direction: "out", author: "gizem", body_text: "Merhaba,\nuygunuz.", send_status: "sent" });
    const st = await env.DB.prepare("SELECT state FROM conversations WHERE id = ?1").bind(conv.id).first<{ state: string }>();
    expect(st!.state).toBe("theirs");
  });

  it("keeps a failed reply and lets the admin resend it", async () => {
    const conv = await newConversation("tekrar@example.com");
    fake.failSends = true;
    const res = await form(`/admin/konusma/${conv.id}/yanit`, "metin=Deneme");
    expect(res.headers.get("location")).toContain("gonderildi=0");
    const failed = (await messages(conv.id)).at(-1)!;
    expect(failed.send_status).toBe("failed");
    const page = await (await SELF.fetch(`https://example.com/admin/konusma/${conv.id}`)).text();
    expect(page).toContain("Gönderilemedi");
    expect(page).toContain(`/admin/mesaj/${failed.id}/tekrar`);

    fake.failSends = false;
    const retry = await form(`/admin/mesaj/${failed.id}/tekrar`, "");
    expect(retry.headers.get("location")).toContain("gonderildi=1");
    expect((await messages(conv.id)).at(-1)!.send_status).toBe("sent");
    expect((await form(`/admin/mesaj/${failed.id}/tekrar`, "")).status).toBe(404); // only failed ones
  });

  it("rejects empty replies and cross-site posts", async () => {
    const conv = await newConversation("bos@example.com");
    expect((await form(`/admin/konusma/${conv.id}/yanit`, "metin=%20")).status).toBe(400);
    const evil = await SELF.fetch(`https://example.com/admin/konusma/${conv.id}/yanit`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
      body: "metin=x",
    });
    expect(evil.status).toBe(403);
  });

  it("shows the customer page link, attachments and the sender when it differs", async () => {
    const conv = await newConversation("detay@example.com");
    fake.attachments.set("adm1", [{ id: "x", filename: "ek.pdf", content_type: "application/pdf", size: 3, download_url: "https://files.test/x" }]);
    fake.downloads.set("/x", new Uint8Array([1, 2, 3]));
    fake.received.set("adm1", {
      id: "adm1", from: "es@example.com", to: [`merhaba+${conv.plus_token}@reply.uceksen.com`], subject: "Re", message_id: "<adm1@x>",
      text: "Eşim yazıyor.", html: null, headers: {}, attachments: [{ id: "x", filename: "ek.pdf", content_type: "application/pdf", size: 3 }],
    });
    await postWebhook({ type: "email.received", data: { email_id: "adm1" } });
    const page = await (await SELF.fetch(`https://example.com/admin/konusma/${conv.id}`)).text();
    expect(page).toContain(`/konusma/${conv.reply_token}`);
    expect(page).toContain("Farklı bir adresten geldi: es@example.com");
    const id = page.match(/\/admin\/ek\/(\d+)/)![1];
    const dl = await SELF.fetch(`https://example.com/admin/ek/${id}`);
    expect(new Uint8Array(await dl.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("lists and deletes unmatched emails", async () => {
    fake.received.set("um1", {
      id: "um1", from: "kim@example.com", to: ["merhaba@reply.uceksen.com"], subject: "Kayıp", message_id: "<um1@x>",
      text: "Bu nereye gidiyor?", html: null, headers: {},
    });
    await postWebhook({ type: "email.received", data: { email_id: "um1" } });
    const list = await (await SELF.fetch("https://example.com/admin/eslesmeyen")).text();
    expect(list).toContain("Bu nereye gidiyor?");
    const id = list.match(/\/admin\/eslesmeyen\/(\d+)\/sil/)![1];
    expect((await form(`/admin/eslesmeyen/${id}/sil`, "")).status).toBe(303);
    expect(await (await SELF.fetch("https://example.com/admin/eslesmeyen")).text()).not.toContain("Bu nereye gidiyor?");
  });
});
