/**
 * Verifies the Cloudflare Access JWT (Cf-Access-Jwt-Assertion header).
 * Access is the authentication; this check makes sure a request that bypassed
 * Access (misconfiguration, direct workers.dev hit) is still refused.
 */

export type Jwk = JsonWebKey & { kid?: string };
export type KeySource = (teamDomain: string) => Promise<Jwk[]>;

type Claims = { aud?: string | string[]; email?: string; exp?: number; nbf?: number; iss?: string };

const keyCache = new Map<string, { keys: Jwk[]; fetchedAt: number }>();

export const fetchAccessKeys: KeySource = async (teamDomain) => {
  const cached = keyCache.get(teamDomain);
  if (cached && Date.now() - cached.fetchedAt < 10 * 60 * 1000) return cached.keys;
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs fetch failed: ${res.status}`);
  const { keys } = (await res.json()) as { keys: Jwk[] };
  keyCache.set(teamDomain, { keys, fetchedAt: Date.now() });
  return keys;
};

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

function decodeJson<T>(part: string): T {
  return JSON.parse(new TextDecoder().decode(b64urlDecode(part))) as T;
}

/** Returns the verified email, or null if the token is missing/invalid. */
export async function verifyAccessJwt(
  token: string | undefined,
  opts: { teamDomain: string; aud: string; keys?: KeySource; now?: number },
): Promise<string | null> {
  if (!token || !opts.teamDomain || !opts.aud) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts as [string, string, string];
  try {
    const header = decodeJson<{ alg?: string; kid?: string }>(h);
    if (header.alg !== "RS256") return null;
    const keys = await (opts.keys ?? fetchAccessKeys)(opts.teamDomain);
    const jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlDecode(sig), new TextEncoder().encode(`${h}.${p}`));
    if (!ok) return null;

    const c = decodeJson<Claims>(p);
    const now = Math.floor((opts.now ?? Date.now()) / 1000);
    const auds = Array.isArray(c.aud) ? c.aud : [c.aud];
    if (!auds.includes(opts.aud)) return null;
    if (c.iss !== `https://${opts.teamDomain}`) return null;
    if (typeof c.exp !== "number" || c.exp <= now) return null;
    if (typeof c.nbf === "number" && c.nbf > now + 60) return null;
    return typeof c.email === "string" ? c.email.toLowerCase() : null;
  } catch {
    return null;
  }
}
