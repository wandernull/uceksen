import { DateTime } from "luxon";

/** Current instant as the canonical stored form: UTC ISO-8601 with ms and "Z". */
export function nowIso(): string {
  return DateTime.utc().toISO();
}

/** Human-readable Turkish timestamp in an IANA zone, e.g. "7 Kas 2026 16:05". */
export function formatTr(iso: string | null | undefined, zone: string): string {
  if (!iso) return "—";
  const dt = DateTime.fromISO(iso, { zone: "utc" });
  if (!dt.isValid) return "—";
  return dt.setZone(zone).setLocale("tr").toFormat("d LLL yyyy HH:mm");
}
