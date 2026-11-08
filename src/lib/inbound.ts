/** Parsing helpers for inbound email. Pure functions; covered by test/inbound.test.ts. */

const ATTRIBUTION_END = /(wrote|yazdı|şunu yazdı|şunları yazdı|schrieb|a écrit|escribió|schreef)\s*:\s*$/i;
// English/French/German/Spanish/Dutch "On …" openers; Turkish clients put the date first ("… tarihinde …").
const ATTRIBUTION_START = /^(On|Le|Am|El|Op)\s|\btarihinde\b/i;
const SEPARATOR = /^-{2,}\s*(Original Message|Orijinal İleti|Özgün İleti|İletilen ileti|Forwarded message)\s*-{2,}\s*$/i;
const UNDERSCORES = /^_{10,}\s*$/;
const HEADER_FROM = /^\*?(From|Kimden)\s*:\*?\s/i;
const HEADER_NEXT = /^\*?(Sent|Date|To|Subject|Cc|Gönderildi|Gönderilme|Tarih|Kime|Konu|Bilgi)\s*:/i;

/**
 * Removes the quoted history that mail clients append to replies (Gmail, Apple Mail,
 * Outlook — English and Turkish), keeping only what the sender wrote on top.
 * Interleaved quotes (reply between quoted lines) are left alone; only a trailing
 * quote block is cut. Returns the original text if stripping would leave nothing.
 */
export function stripQuotes(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let cut = lines.length;

  for (let i = 0; i < lines.length && i < cut; i++) {
    const line = (lines[i] ?? "").trim();
    if (SEPARATOR.test(line)) { cut = i; break; }
    if (UNDERSCORES.test(line) && lines.slice(i + 1, i + 4).some((l) => HEADER_FROM.test(l.trim()))) { cut = i; break; }
    if (HEADER_FROM.test(line) && lines.slice(i + 1, i + 5).some((l) => HEADER_NEXT.test(l.trim()))) { cut = i; break; }
    if (ATTRIBUTION_END.test(line)) {
      // The attribution may be wrapped over two or three lines ("On …, Name <" / "a@b> wrote:").
      let start = i;
      for (let j = i - 1; j >= Math.max(0, i - 2); j--) {
        const prev = (lines[j] ?? "").trim();
        if (!prev) break;
        start = j;
        if (ATTRIBUTION_START.test(prev)) break;
      }
      if (start !== i && !ATTRIBUTION_START.test((lines[start] ?? "").trim())) start = i;
      cut = start;
      break;
    }
  }

  // Trailing ">" block: every non-blank line from here to the end is quoted.
  for (let i = 0; i < cut; i++) {
    if (!(lines[i] ?? "").trimStart().startsWith(">")) continue;
    const rest = lines.slice(i, cut).filter((l) => l.trim());
    if (rest.every((l) => l.trimStart().startsWith(">"))) { cut = i; break; }
  }

  const kept = lines.slice(0, cut).join("\n").replace(/\s+$/, "");
  return kept.trim() ? kept.replace(/^\s*\n/, "") : text.trim();
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Crude HTML → text for emails that arrive without a text part. Drops quoted history. */
export function htmlToText(html: string): string {
  let h = html;
  // Cut quoted history: Gmail, Apple Mail/Thunderbird (<blockquote type="cite">), Outlook.
  const markers = [/<div[^>]*class="[^"]*gmail_quote/i, /<blockquote[^>]*type="cite"/i, /<div[^>]*id="(divRplyFwdMsg|appendonsend)"/i];
  for (const m of markers) {
    const idx = h.search(m);
    if (idx >= 0) h = h.slice(0, idx);
  }
  h = h
    .replace(/<(head|style|script)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
      if (e[0] === "#") {
        const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(cp) ? String.fromCodePoint(cp) : all;
      }
      return ENTITIES[e.toLowerCase()] ?? all;
    });
  return h.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** `"Name" <a@b.com>` / `Name <a@b.com>` / `a@b.com` → lower-cased address. */
export function parseAddress(raw: string | null | undefined): { name: string | null; email: string } | null {
  if (!raw) return null;
  const m = raw.match(/^\s*(?:"?([^"<]*?)"?\s*)?<([^<>\s]+@[^<>\s]+)>\s*$/);
  if (m) return { name: m[1]?.trim() || null, email: (m[2] ?? "").toLowerCase() };
  const bare = raw.trim();
  return /^[^\s@<>]+@[^\s@<>]+$/.test(bare) ? { name: null, email: bare.toLowerCase() } : null;
}

/** All `<id>` values from In-Reply-To / References (plain string or Resend's JSON-array string). */
export function parseMessageIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return [...new Set(raw.match(/<[^<>\s]+>/g) ?? [])];
}

/** Finds the conversation token in `local+token@domain` among the given addresses. */
export function extractPlusToken(addresses: (string | null | undefined)[], local: string, domain: string): string | null {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${esc(local)}\\+([a-z2-7]{32})@${esc(domain)}$`, "i");
  for (const a of addresses) {
    const email = parseAddress(a)?.email;
    const m = email?.match(re);
    if (m?.[1]) return m[1].toLowerCase();
  }
  return null;
}
