export async function getHostTz(db: D1Database): Promise<string> {
  const row = await db.prepare("SELECT host_tz FROM settings WHERE id = 1").first<{ host_tz: string }>();
  return row?.host_tz ?? "Europe/Istanbul";
}
