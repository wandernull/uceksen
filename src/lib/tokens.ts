/** Cryptographically random URL-safe token. 24 bytes → 32 base64url chars (192 bits). */
export function randomToken(bytes = 24): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  let bin = "";
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/**
 * Lower-case base32 token for email addresses (the plus part of Reply-To).
 * Mail systems may change the case of an address, so the token must be
 * case-insensitive. 20 bytes → 32 chars (160 bits).
 */
export function randomMailToken(bytes = 20): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  let out = "";
  let acc = 0;
  let bits = 0;
  for (const b of buf) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(acc << (5 - bits)) & 31];
  return out;
}
