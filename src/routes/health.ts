import { Hono } from "hono";
import type { AppEnv } from "../env";

export const health = new Hono<AppEnv>();

health.get("/", async (c) => {
  let db = false;
  try {
    const row = await c.env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
    db = row?.ok === 1;
  } catch {
    db = false;
  }
  const status = db ? 200 : 503;
  return c.json({ ok: db, environment: c.env.ENVIRONMENT, db }, status);
});
