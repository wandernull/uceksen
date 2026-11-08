import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { buildIcs, escapeText, fold } from "../src/lib/ics";

const base = {
  id: 42,
  start_utc: "2026-12-15T11:00:00.000Z",
  end_utc: "2026-12-15T12:30:00.000Z",
  state: "confirmed",
  reschedule_count: 0,
  meet_url: null as string | null,
  manageUrl: "https://uceksen.com/randevu/abcdefghijklmnopqrstuvwxyzABCDEF/degistir",
  domain: "uceksen.com",
};
const NOW = DateTime.fromISO("2026-12-01T10:00:00Z", { zone: "utc" });

/** RFC 5545 unfolding + property map (first occurrence). */
function parse(ics: string) {
  const lines = ics.replace(/\r\n /g, "").split("\r\n").filter(Boolean);
  const props = new Map<string, string>();
  for (const l of lines) {
    const i = l.indexOf(":");
    const name = l.slice(0, i);
    if (!props.has(name)) props.set(name, l.slice(i + 1));
  }
  return { lines, props };
}

describe(".ics", () => {
  it("is a PUBLISH calendar with our organizer, UTC times and no attendee", () => {
    const ics = buildIcs(base, NOW);
    const { lines, props } = parse(ics);
    expect(lines[0]).toBe("BEGIN:VCALENDAR");
    expect(lines.at(-1)).toBe("END:VCALENDAR");
    expect(props.get("METHOD")).toBe("PUBLISH");
    expect(props.get("ORGANIZER;CN=Üç Eksen")).toBe("mailto:merhaba@uceksen.com");
    expect(props.get("UID")).toBe("booking-42@uceksen.com");
    expect(props.get("DTSTART")).toBe("20261215T110000Z");
    expect(props.get("DTEND")).toBe("20261215T123000Z");
    expect(props.get("DTSTAMP")).toBe("20261201T100000Z");
    expect(props.get("STATUS")).toBe("CONFIRMED");
    expect(props.get("SEQUENCE")).toBe("0");
    expect(ics).not.toMatch(/ATTENDEE/);
    expect(props.get("DESCRIPTION")).toContain(base.manageUrl);
  });

  it("uses CRLF and folds lines at 75 octets without splitting UTF-8 characters", () => {
    const ics = buildIcs({ ...base, meet_url: "https://meet.google.com/abc-defg-hij" }, NOW);
    expect(ics.endsWith("\r\n")).toBe(true);
    expect(ics.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    for (const l of ics.split("\r\n")) expect(new TextEncoder().encode(l).length).toBeLessThanOrEqual(75);
    const long = "ğüşıöç".repeat(30);
    const folded = fold(`DESCRIPTION:${long}`);
    expect(folded.replace(/\r\n /g, "")).toBe(`DESCRIPTION:${long}`);
    expect(folded).not.toMatch(/�/);
    const { props } = parse(ics);
    expect(props.get("LOCATION")).toBe("https://meet.google.com/abc-defg-hij");
  });

  it("escapes text values", () => {
    expect(escapeText("a,b;c\\d\ne")).toBe("a\\,b\\;c\\\\d\\ne");
  });

  it("a reschedule bumps SEQUENCE; a cancellation keeps the UID and marks it cancelled", () => {
    expect(parse(buildIcs({ ...base, reschedule_count: 1, state: "rescheduled" }, NOW)).props.get("SEQUENCE")).toBe("1");
    const c = parse(buildIcs({ ...base, reschedule_count: 1, state: "cancelled" }, NOW)).props;
    expect(c.get("SEQUENCE")).toBe("2");
    expect(c.get("STATUS")).toBe("CANCELLED");
    expect(c.get("UID")).toBe("booking-42@uceksen.com");
    expect(c.get("METHOD")).toBe("PUBLISH");
  });
});
