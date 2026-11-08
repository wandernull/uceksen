import { DateTime, Interval } from "luxon";

/**
 * Slot computation (SPEC §5.5). Pure: everything comes in as data, so it is tested
 * without a database. Wall-clock times ("HH:mm", "yyyy-MM-dd") are in the host's
 * IANA zone; instants are UTC ISO strings. Computed on every request, never cached.
 */

export const SESSION_MINUTES = 90;

/** 0 = Monday … 6 = Sunday (Luxon weekday − 1). */
export type Rule = { weekday: number; start_time: string; end_time: string; active?: number };
export type Override = { date: string; type: "block" | "extra"; start_time: string | null; end_time: string | null };
export type Busy = { start: string; end: string };
export type SlotSettings = {
  host_tz: string;
  min_notice_hours: number;
  max_horizon_days: number;
  buffer_before_min: number;
  buffer_after_min: number;
  max_per_week: number;
  slot_times: string[];
};
export type Slot = { start: string; end: string };

export type SlotInput = {
  settings: SlotSettings;
  rules: Rule[];
  overrides: Override[];
  /** Live bookings (confirmed / rescheduled). Buffers apply around them. */
  bookings: Busy[];
  /** Other busy time (Google freebusy from Phase 6). Buffers apply too. */
  busy?: Busy[];
  now: DateTime;
};

export const isoUtc = (dt: DateTime) => dt.toUTC().toISO()!;
export const isValidZone = (tz: string) => !!tz && DateTime.now().setZone(tz).isValid;
export const isHhmm = (s: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

/** Local wall-clock time on a date in a zone; null if it does not exist that day (DST gap). */
export function wallClock(date: string, hhmm: string, zone: string): DateTime | null {
  const [h, m] = hhmm.split(":").map(Number);
  const [y, mo, d] = date.split("-").map(Number);
  const dt = DateTime.fromObject({ year: y, month: mo, day: d, hour: h, minute: m }, { zone });
  if (!dt.isValid || dt.hour !== h || dt.minute !== m) return null;
  return dt;
}

function window(date: string, start: string | null, end: string | null, zone: string): Interval | null {
  // A missing start/end means the whole day (from the day's first to the next day's first moment).
  const dayStart = DateTime.fromISO(date, { zone }).startOf("day");
  const s = start ? wallClock(date, start, zone) : dayStart;
  const e = end ? (end === "24:00" ? dayStart.plus({ days: 1 }) : wallClock(date, end, zone)) : dayStart.plus({ days: 1 });
  if (!s || !e || e <= s) return null;
  return Interval.fromDateTimes(s, e);
}

const toInterval = (b: Busy) => Interval.fromDateTimes(DateTime.fromISO(b.start, { zone: "utc" }), DateTime.fromISO(b.end, { zone: "utc" }));

/** ISO week key ("2026-W50") in the host zone, used for max_per_week. */
const weekKey = (dt: DateTime, zone: string) => {
  const z = dt.setZone(zone);
  return `${z.weekYear}-W${z.weekNumber}`;
};

export function computeSlots(input: SlotInput): Slot[] {
  const { settings: s, now } = input;
  const zone = s.host_tz;
  const earliest = now.plus({ hours: s.min_notice_hours });
  const latest = now.plus({ days: s.max_horizon_days });

  // Busy time including buffers: no slot may start within buffer_after of a busy end,
  // or end within buffer_before of a busy start.
  const blocked = [...input.bookings, ...(input.busy ?? [])].map((b) => {
    const i = toInterval(b);
    return Interval.fromDateTimes(i.start!.minus({ minutes: s.buffer_before_min }), i.end!.plus({ minutes: s.buffer_after_min }));
  });

  const perWeek = new Map<string, number>();
  for (const b of input.bookings) {
    const k = weekKey(DateTime.fromISO(b.start, { zone: "utc" }), zone);
    perWeek.set(k, (perWeek.get(k) ?? 0) + 1);
  }

  const out: Slot[] = [];
  const firstDay = now.setZone(zone).startOf("day");
  const days = s.max_horizon_days + 1;
  const slotTimes = [...new Set(s.slot_times.filter(isHhmm))].sort();

  for (let i = 0; i <= days; i++) {
    const day = firstDay.plus({ days: i });
    const date = day.toISODate()!;
    const weekday = day.weekday - 1;
    const dayOverrides = input.overrides.filter((o) => o.date === date);

    const open = [
      ...input.rules.filter((r) => r.weekday === weekday && (r.active ?? 1) === 1).map((r) => window(date, r.start_time, r.end_time, zone)),
      ...dayOverrides.filter((o) => o.type === "extra").map((o) => window(date, o.start_time, o.end_time, zone)),
    ].filter((w): w is Interval => !!w);
    if (!open.length) continue;
    const closed = dayOverrides.filter((o) => o.type === "block").map((o) => window(date, o.start_time, o.end_time, zone)).filter((w): w is Interval => !!w);

    for (const t of slotTimes) {
      const start = wallClock(date, t, zone);
      if (!start) continue; // does not exist on this day (spring-forward gap)
      const end = start.plus({ minutes: SESSION_MINUTES });
      const slot = Interval.fromDateTimes(start, end);
      if (start < earliest || start > latest) continue;
      if (!open.some((w) => w.engulfs(slot))) continue;
      if (closed.some((w) => w.overlaps(slot))) continue;
      if (blocked.some((b) => b.overlaps(slot))) continue;
      if ((perWeek.get(weekKey(start, zone)) ?? 0) >= s.max_per_week) continue;
      out.push({ start: isoUtc(start), end: isoUtc(end) });
    }
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

/** Turkish display of an instant in a zone, e.g. "15 Aralık 2026 Salı, 14:00". */
export function formatSlot(iso: string, zone: string, fmt = "d LLLL yyyy cccc, HH:mm"): string {
  return DateTime.fromISO(iso, { zone: "utc" }).setZone(zone).setLocale("tr").toFormat(fmt);
}

export const WEEKDAYS_TR = ["Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi", "Pazar"] as const;
