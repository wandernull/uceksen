/**
 * Resend signs webhooks the Svix way:
 *   signed content = `${svix-id}.${svix-timestamp}.${raw body}`
 *   signature      = base64(HMAC-SHA256(base64decode(secret without "whsec_"), content))
 *   svix-signature = space-separated "v1,<sig>" entries (several during key rotation)
 * Requests older or newer than the tolerance are rejected (replay protection).
 */
export const TOLERANCE_SEC = 5 * 60;

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: ArrayBuffer): string {
  let bin = "";
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signWebhook(secret: string, id: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    b64ToBytes(secret.replace(/^whsec_/, "")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return bytesToB64(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)));
}

export async function verifyWebhook(
  secret: string | undefined,
  headers: { id: string | undefined; timestamp: string | undefined; signature: string | undefined },
  body: string,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const { id, timestamp, signature } = headers;
  if (!secret || !id || !timestamp || !signature) return false;
  if (!/^\d+$/.test(timestamp) || Math.abs(nowSec - Number(timestamp)) > TOLERANCE_SEC) return false;
  let expected: string;
  try {
    expected = await signWebhook(secret, id, timestamp, body);
  } catch {
    return false; // malformed secret
  }
  return signature
    .split(" ")
    .map((s) => s.split(","))
    .some(([version, sig]) => version === "v1" && !!sig && timingSafeEqual(sig, expected));
}
