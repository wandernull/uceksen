import type { Busy, Override, Rule, SlotSettings } from "./slots";

export async function getHostTz(db: D1Database): Promise<string> {
  const row = await db.prepare("SELECT host_tz FROM settings WHERE id = 1").first<{ host_tz: string }>();
  return row?.host_tz ?? "Europe/Istanbul";
}

type SettingsRow = Omit<SlotSettings, "slot_times"> & { slot_times_json: string };

export async function getSlotSettings(db: D1Database): Promise<SlotSettings> {
  const r = await db.prepare(
    "SELECT host_tz, min_notice_hours, max_horizon_days, buffer_before_min, buffer_after_min, max_per_week, slot_times_json FROM settings WHERE id = 1",
  ).first<SettingsRow>();
  let slotTimes: string[] = [];
  try {
    slotTimes = JSON.parse(r?.slot_times_json ?? "[]");
  } catch {
    slotTimes = [];
  }
  return {
    host_tz: r?.host_tz ?? "Europe/Istanbul",
    min_notice_hours: r?.min_notice_hours ?? 48,
    max_horizon_days: r?.max_horizon_days ?? 45,
    buffer_before_min: r?.buffer_before_min ?? 15,
    buffer_after_min: r?.buffer_after_min ?? 30,
    max_per_week: r?.max_per_week ?? 3,
    slot_times: Array.isArray(slotTimes) ? slotTimes.map(String) : [],
  };
}

/** Everything slot computation needs from the database. */
export async function loadAvailability(db: D1Database, opts: { excludeBookingId?: number } = {}) {
  const [settings, rules, overrides, bookings] = await Promise.all([
    getSlotSettings(db),
    db.prepare("SELECT weekday, start_time, end_time, active FROM availability_rules WHERE active = 1").all<Rule>(),
    db.prepare("SELECT date, type, start_time, end_time FROM date_overrides WHERE date >= date('now', '-1 day')").all<Override>(),
    db.prepare(
      `SELECT start_utc AS start, end_utc AS end FROM bookings
        WHERE state IN ('confirmed', 'rescheduled') AND end_utc >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day') AND id != ?1`,
    ).bind(opts.excludeBookingId ?? -1).all<Busy>(),
  ]);
  return { settings, rules: rules.results, overrides: overrides.results, bookings: bookings.results };
}
