import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { applyDevGuard, MailGuardError, sendMail } from "../src/lib/mail";
import { fake } from "./fake-resend";

const mail = { to: ["musteri@example.com", "ikinci@example.com"], subject: "Konu", text: "Merhaba" };

describe("DEV_EMAIL guard", () => {
  for (const ENVIRONMENT of ["staging", "local", "test", "", "prod", "Production"]) {
    it(`redirects every recipient to DEV_EMAIL when ENVIRONMENT=${JSON.stringify(ENVIRONMENT)}`, () => {
      const out = applyDevGuard({ ENVIRONMENT, DEV_EMAIL: "dev@example.com" }, mail);
      expect(out.to).toEqual(["dev@example.com"]);
      expect(out.subject).toBe("[TEST] Konu");
      expect(out.text).toContain("asıl alıcı: musteri@example.com, ikinci@example.com");
      expect(out.text).toContain("Merhaba");
    });
  }

  it("leaves mail untouched only for exactly ENVIRONMENT=production", () => {
    expect(applyDevGuard({ ENVIRONMENT: "production", DEV_EMAIL: "dev@example.com" }, mail)).toEqual(mail);
  });

  it("refuses to send at all outside production when DEV_EMAIL is missing", async () => {
    fake.reset();
    for (const DEV_EMAIL of [undefined, "", "   "]) {
      expect(() => applyDevGuard({ ENVIRONMENT: "staging", DEV_EMAIL } as Env, mail)).toThrow(MailGuardError);
      await expect(sendMail({ ...env, ENVIRONMENT: "staging", DEV_EMAIL } as Env, mail)).rejects.toThrow(MailGuardError);
    }
    expect(fake.sent).toHaveLength(0);
  });
});

describe("sendMail", () => {
  beforeEach(() => fake.reset());

  it("sends through Resend with from, reply-to and threading headers — to DEV_EMAIL in tests", async () => {
    const { id } = await sendMail(env, {
      ...mail,
      replyTo: "merhaba+abc@reply.uceksen.com",
      inReplyTo: "<b@x>",
      references: ["<a@x>", "<b@x>"],
    });
    expect(id).toMatch(/^re_/);
    expect(fake.sent).toHaveLength(1);
    const s = fake.sent[0]!;
    expect(s.to).toEqual(["dev@example.com"]);
    expect(s.from).toBe("Üç Eksen <merhaba@uceksen.com>");
    expect(s.reply_to).toBe("merhaba+abc@reply.uceksen.com");
    expect(s.headers).toEqual({ "In-Reply-To": "<b@x>", References: "<a@x> <b@x>" });
  });

  it("throws on a Resend error", async () => {
    fake.failSends = true;
    await expect(sendMail(env, mail)).rejects.toThrow(/Resend POST \/emails: 500/);
  });
});
