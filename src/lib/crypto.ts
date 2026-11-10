/**
 * AES-256-GCM for secrets at rest (the Google refresh token). ENCRYPTION_KEY is 32 random
 * bytes, base64. Stored form: "v1." + base64(iv ‖ ciphertext+tag). The purpose string is
 * bound as additional data, so a ciphertext cannot be reused for another field.
 */

const b64 = (bytes: Uint8Array) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function key(secret: string): Promise<CryptoKey> {
  const raw = unb64(secret.trim());
  if (raw.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes, base64");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptText(secret: string, purpose: string, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(purpose) }, await key(secret), new TextEncoder().encode(plain)),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return `v1.${b64(out)}`;
}

/** Throws if the value was tampered with, encrypted with another key, or for another purpose. */
export async function decryptText(secret: string, purpose: string, stored: string): Promise<string> {
  if (!stored.startsWith("v1.")) throw new Error("unknown ciphertext format");
  const all = unb64(stored.slice(3));
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: all.slice(0, 12), additionalData: new TextEncoder().encode(purpose) },
    await key(secret),
    all.slice(12),
  );
  return new TextDecoder().decode(plain);
}
