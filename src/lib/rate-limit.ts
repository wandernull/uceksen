/**
 * Fixed-window rate limit in KV. Returns true if the call is allowed (and counts it).
 * KV is eventually consistent across locations, so this is a soft limit — good
 * enough for form abuse, not a hard security boundary.
 */
export async function allow(kv: KVNamespace, key: string, limit: number, windowSec: number): Promise<boolean> {
  const bucket = Math.floor(Date.now() / 1000 / windowSec);
  const k = `rl:${key}:${bucket}`;
  const used = Number.parseInt((await kv.get(k)) ?? "0", 10) || 0;
  if (used >= limit) return false;
  await kv.put(k, String(used + 1), { expirationTtl: Math.max(60, windowSec * 2) });
  return true;
}

export function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip") ?? "unknown";
}
