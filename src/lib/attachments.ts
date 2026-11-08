import { randomToken } from "./tokens";

export const ATTACH = {
  maxFiles: 5,
  maxBytes: 10 * 1024 * 1024,
  /** Web uploads only; inbound email attachments are kept whatever their type. */
  extensions: ["pdf", "jpg", "jpeg", "png", "heic", "webp", "doc", "docx", "xls", "xlsx", "csv", "txt", "odt", "ods"],
} as const;

/** Types the browser may display inline-safe; everything else is served as a plain download. */
const SAFE_TYPES = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp", "image/gif", "text/plain", "text/csv"]);

export function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "dosya";
  const cleaned = base.normalize("NFKD").replace(/[^\w.\-]+/g, "_").replace(/^\.+/, "").slice(-100);
  return cleaned || "dosya";
}

export function extensionAllowed(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return (ATTACH.extensions as readonly string[]).includes(ext);
}

export async function storeAttachment(
  env: Pick<Env, "DB" | "BUCKET">,
  a: { convId: number; messageId: number; filename: string; contentType: string; body: ArrayBuffer | ReadableStream; size: number },
): Promise<void> {
  const name = safeFilename(a.filename);
  const key = `att/${a.convId}/${randomToken(12)}/${name}`;
  const type = a.contentType || "application/octet-stream";
  await env.BUCKET.put(key, a.body, { httpMetadata: { contentType: type } });
  await env.DB.prepare(
    "INSERT INTO attachments (message_id, r2_key, filename, content_type, size) VALUES (?1, ?2, ?3, ?4, ?5)",
  )
    .bind(a.messageId, key, a.filename.slice(0, 200) || name, type, a.size)
    .run();
}

export type AttachmentRow = { id: number; message_id: number; filename: string; size: number };

export async function attachmentsFor(db: D1Database, convId: number): Promise<Map<number, AttachmentRow[]>> {
  const rows = await db
    .prepare(
      `SELECT a.id, a.message_id, a.filename, a.size FROM attachments a
         JOIN messages m ON m.id = a.message_id WHERE m.conversation_id = ?1 ORDER BY a.id`,
    )
    .bind(convId)
    .all<AttachmentRow>();
  const by = new Map<number, AttachmentRow[]>();
  for (const r of rows.results) by.set(r.message_id, [...(by.get(r.message_id) ?? []), r]);
  return by;
}

/** Streams an attachment from R2 as a download (never rendered inline). */
export async function serveAttachment(env: Pick<Env, "BUCKET">, row: { r2_key: string; filename: string; content_type: string }): Promise<Response> {
  const obj = await env.BUCKET.get(row.r2_key);
  if (!obj) return new Response("Dosya bulunamadı.", { status: 404 });
  const type = SAFE_TYPES.has(row.content_type) ? row.content_type : "application/octet-stream";
  return new Response(obj.body, {
    headers: {
      "Content-Type": type,
      "Content-Disposition": `attachment; filename="${safeFilename(row.filename)}"; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} MB`;
}
