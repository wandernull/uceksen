import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { computeSlots, formatSlot, type Override, type Rule, type SlotInput, type SlotSettings } from "../src/lib/slots";

const SETTINGS: SlotSettings = {
  host_tz: "Europe/Istanbul",
  min_notice_hours: 48,
  max_horizon_days: 45,
  buffer_before_min: 15,
  buffer_after_min: 30,
  max_per_week: 3,
  slot_times: ["10:00", "14:00", "16:00"],
};
// Monday–Friday, 09:00–18:00 (0 = Monday).
const WEEKDAYS: Rule[] = [0, 1, 2, 3, 4].map((weekday) => ({ weekday, start_time: "09:00", end_time: "18:00" }));
const ALL_DAY: Rule[] = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start_time: "00:00", end_time: "24:00" }));
// Tuesday 1 Dec 2026, 09:00 in Istanbul (UTC+3 all year).
const NOW = DateTime.fromISO("2026-12-01T06:00:00Z", { zone: "utc" });

const slots = (over: Partial<SlotInput> = {}, settings: Partial<SlotSettings> = {}) =>
  computeSlots({ settings: { ...SETTINGS, ...settings }, rules: WEEKDAYS, overrides: [], bookings: [], now: NOW, ...over });
const starts = (over: Partial<SlotInput> = {}, settings: Partial<SlotSettings> = {}) => slots(over, settings).map((s) => s.start);
const onDay = (list: string[], date: string, zone = "Europe/Istanbul") =>
  list.filter((s) => DateTime.fromISO(s, { zone: "utc" }).setZone(zone).toISODate() === date);

describe("slot computation", () => {
  it("offers the fixed start times inside working hours, after the minimum notice", () => {
    const s = slots();
    expect(s.slice(0, 3)).toEqual([
      { start: "2026-12-03T07:00:00.000Z", end: "2026-12-03T08:30:00.000Z" }, // Thu 10:00–11:30 Istanbul
      { start: "2026-12-03T11:00:00.000Z", end: "2026-12-03T12:30:00.000Z" },
      { start: "2026-12-03T13:00:00.000Z", end: "2026-12-03T14:30:00.000Z" },
    ]);
    // Nothing on Tue/Wed (inside 48 h), nothing at the weekend.
    expect(onDay(s.map((x) => x.start), "2026-12-02")).toEqual([]);
    expect(onDay(s.map((x) => x.start), "2026-12-05")).toEqual([]);
    expect(onDay(s.map((x) => x.start), "2026-12-06")).toEqual([]);
  });

  it("only offers a slot if the whole 90 minutes fit in a window", () => {
    const s = starts({ rules: [{ weekday: 3, start_time: "09:00", end_time: "15:00" }] });
    expect(onDay(s, "2026-12-03")).toEqual(["2026-12-03T07:00:00.000Z"]); // 14:00 would end 15:30
  });

  it("stops at the booking horizon", () => {
    const s = starts();
    const last = DateTime.fromISO(s.at(-1)!);
    expect(last <= NOW.plus({ days: 45 })).toBe(true);
    expect(last > NOW.plus({ days: 40 })).toBe(true);
    expect(starts({}, { max_horizon_days: 3 })).toHaveLength(3); // only Thursday fits
  });

  it("blocks whole days and time ranges; extra openings add slots on closed days", () => {
    const overrides: Override[] = [
      { date: "2026-12-03", type: "block", start_time: null, end_time: null },
      { date: "2026-12-04", type: "block", start_time: "13:00", end_time: "15:00" },
      { date: "2026-12-05", type: "extra", start_time: "10:00", end_time: "12:00" },
    ];
    const s = starts({ overrides });
    expect(onDay(s, "2026-12-03")).toEqual([]);
    expect(onDay(s, "2026-12-04")).toEqual(["2026-12-04T07:00:00.000Z", "2026-12-04T13:00:00.000Z"]); // 14:00 gone
    expect(onDay(s, "2026-12-05")).toEqual(["2026-12-05T07:00:00.000Z"]); // Saturday 10:00
  });

  it("removes booked slots and respects buffers around busy time", () => {
    const booked = starts({ bookings: [{ start: "2026-12-03T11:00:00.000Z", end: "2026-12-03T12:30:00.000Z" }] });
    expect(onDay(booked, "2026-12-03")).toEqual(["2026-12-03T07:00:00.000Z", "2026-12-03T13:00:00.000Z"]);
    // Busy 12:30–13:50 local: 14:00 starts within 30 min of its end → gone.
    const tight = starts({ busy: [{ start: "2026-12-03T09:30:00.000Z", end: "2026-12-03T10:50:00.000Z" }] });
    expect(onDay(tight, "2026-12-03")).not.toContain("2026-12-03T11:00:00.000Z");
    // Busy until 13:29 local: exactly 31 min before 14:00 → stays.
    const ok = starts({ busy: [{ start: "2026-12-03T09:00:00.000Z", end: "2026-12-03T10:29:00.000Z" }] });
    expect(onDay(ok, "2026-12-03")).toContain("2026-12-03T11:00:00.000Z");
    // Busy from 11:40 local: within 15 min of the 10:00 slot's end (11:30) → 10:00 gone.
    const before = starts({ busy: [{ start: "2026-12-03T08:40:00.000Z", end: "2026-12-03T09:00:00.000Z" }] });
    expect(onDay(before, "2026-12-03")).not.toContain("2026-12-03T07:00:00.000Z");
  });

  it("closes a week once max_per_week bookings are in it", () => {
    const week = [
      { start: "2026-12-07T07:00:00.000Z", end: "2026-12-07T08:30:00.000Z" },
      { start: "2026-12-08T07:00:00.000Z", end: "2026-12-08T08:30:00.000Z" },
    ];
    expect(onDay(starts({ bookings: week }), "2026-12-09")).toHaveLength(3);
    const full = starts({ bookings: [...week, { start: "2026-12-09T07:00:00.000Z", end: "2026-12-09T08:30:00.000Z" }] });
    for (const d of ["2026-12-07", "2026-12-08", "2026-12-09", "2026-12-10", "2026-12-11"]) expect(onDay(full, d)).toEqual([]);
    expect(onDay(full, "2026-12-14")).toHaveLength(3); // next week open again
  });

  it("an existing booking keeps its instant when host_tz changes", () => {
    const booking = [{ start: "2026-12-03T13:00:00.000Z", end: "2026-12-03T14:30:00.000Z" }];
    // In Istanbul that is the 16:00 slot.
    expect(onDay(starts({ bookings: booking }), "2026-12-03")).toEqual(["2026-12-03T07:00:00.000Z", "2026-12-03T11:00:00.000Z"]);
    // In Amsterdam (UTC+1) slots move to other instants; the booking still blocks 13:00Z (14:00 there).
    const ams = starts({ bookings: booking }, { host_tz: "Europe/Amsterdam" });
    expect(onDay(ams, "2026-12-03", "Europe/Amsterdam")).toEqual(["2026-12-03T09:00:00.000Z", "2026-12-03T15:00:00.000Z"]);
  });
});

describe("DST transitions (host Europe/Amsterdam)", () => {
  const ams = { host_tz: "Europe/Amsterdam", min_notice_hours: 0, max_horizon_days: 15, max_per_week: 99, slot_times: ["02:30", "10:00"] };

  it("spring forward (29 Mar 2026): 10:00 moves from 09:00Z to 08:00Z, 02:30 does not exist", () => {
    const s = starts({ rules: ALL_DAY, now: DateTime.fromISO("2026-03-20T00:00:00Z") }, ams);
    expect(onDay(s, "2026-03-28", "Europe/Amsterdam")).toEqual(["2026-03-28T01:30:00.000Z", "2026-03-28T09:00:00.000Z"]);
    expect(onDay(s, "2026-03-29", "Europe/Amsterdam")).toEqual(["2026-03-29T08:00:00.000Z"]);
    expect(onDay(s, "2026-03-30", "Europe/Amsterdam")).toEqual(["2026-03-30T00:30:00.000Z", "2026-03-30T08:00:00.000Z"]);
  });

  it("fall back (25 Oct 2026): 10:00 moves from 08:00Z to 09:00Z, the repeated 02:30 is offered once", () => {
    const s = starts({ rules: ALL_DAY, now: DateTime.fromISO("2026-10-20T00:00:00Z") }, ams);
    expect(onDay(s, "2026-10-24", "Europe/Amsterdam")).toEqual(["2026-10-24T00:30:00.000Z", "2026-10-24T08:00:00.000Z"]);
    const sunday = onDay(s, "2026-10-25", "Europe/Amsterdam");
    expect(sunday).toHaveLength(2);
    expect(sunday[1]).toBe("2026-10-25T09:00:00.000Z");
  });

  it("a window spanning the change keeps 90-minute slots honest", () => {
    // 01:00–04:00 on the spring-forward night is only 2 real hours: 01:30 fits, 02:30 doesn't exist.
    const s = starts(
      { rules: [{ weekday: 6, start_time: "01:00", end_time: "04:00" }], now: DateTime.fromISO("2026-03-27T00:00:00Z") },
      { ...ams, slot_times: ["01:30", "02:30"] },
    );
    expect(onDay(s, "2026-03-29", "Europe/Amsterdam")).toEqual(["2026-03-29T00:30:00.000Z"]);
  });
});

describe("display in the customer's zone", () => {
  it("renders one instant correctly in zones with different DST rules", () => {
    // 29 Mar 2026 08:00Z: Amsterdam already on summer time, New York since 8 Mar, Istanbul has none.
    const t = "2026-03-29T08:00:00.000Z";
    expect(formatSlot(t, "Europe/Amsterdam")).toBe("29 Mart 2026 Pazar, 10:00");
    expect(formatSlot(t, "Europe/Istanbul")).toBe("29 Mart 2026 Pazar, 11:00");
    expect(formatSlot(t, "America/New_York")).toBe("29 Mart 2026 Pazar, 04:00");
    // One week earlier, New York is on summer time but Amsterdam is not yet.
    expect(formatSlot("2026-03-22T09:00:00.000Z", "Europe/Amsterdam")).toBe("22 Mart 2026 Pazar, 10:00");
    expect(formatSlot("2026-03-22T09:00:00.000Z", "America/New_York")).toBe("22 Mart 2026 Pazar, 05:00");
  });
});
