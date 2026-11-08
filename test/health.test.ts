import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("/health", () => {
  it("returns 200 with a reachable database", async () => {
    const res = await SELF.fetch("https://example.com/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, environment: "test", db: true });
  });
});

describe("schema", () => {
  it("has every table from the data model and a seeded settings row", async () => {
    const { env } = await import("cloudflare:test");
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' AND name <> '_cf_KV' ORDER BY name",
    ).all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual([
      "attachments",
      "availability_rules",
      "booking_intents",
      "bookings",
      "contacts",
      "conversations",
      "date_overrides",
      "download_tokens",
      "guide_versions",
      "messages",
      "purchases",
      "settings",
      "unmatched_emails",
    ]);
    const s = await env.DB.prepare("SELECT host_tz, min_notice_hours, slot_times_json FROM settings WHERE id = 1").first();
    expect(s).toEqual({ host_tz: "Europe/Istanbul", min_notice_hours: 48, slot_times_json: '["10:00","14:00","16:00"]' });
  });

  it("rejects a second booking at the same start_utc", async () => {
    const { env } = await import("cloudflare:test");
    await env.DB.prepare("INSERT INTO contacts (email, name) VALUES ('a@example.com', 'A')").run();
    const insert = () =>
      env.DB.prepare(
        "INSERT INTO bookings (contact_id, start_utc, end_utc, customer_tz, state) VALUES (1, '2027-03-28T07:00:00.000Z', '2027-03-28T08:30:00.000Z', 'Europe/Amsterdam', 'confirmed')",
      ).run();
    await insert();
    await expect(insert()).rejects.toThrow(/UNIQUE/);
  });
});
