import { Hono } from "hono";
import { csrf } from "hono/csrf";
import type { AppEnv } from "../../env";
import { requireAdmin } from "../../lib/admin-auth";
import { parseAdmins } from "../../lib/admins";
import { authUrl, disconnect, finishAuth, getGoogleSettings, isWritable, listCalendars, saveCalendarChoices } from "../../lib/google";

/** /admin/google: connect Gizem's Google account (OAuth), choose calendars, disconnect. */
export const adminGoogle = new Hono<AppEnv>();
adminGoogle.use("*", requireAdmin);
adminGoogle.use("*", csrf());

const back = (k: string) => `/admin/takvim?google=${k}#google`;

adminGoogle.post("/baglan", async (c) => {
  // Hint Google towards Gizem's account: the calendar and the Meet links are hers.
  const hint = parseAdmins(c.env.ADMIN_EMAILS).find((a) => a.author === "gizem")?.email;
  return c.redirect(await authUrl(c.env, c.get("admin").email, hint), 303);
});

adminGoogle.get("/callback", async (c) => {
  const r = await finishAuth(c.env, { state: c.req.query("state"), code: c.req.query("code"), error: c.req.query("error") }, c.get("admin").email);
  if (!r.ok) return c.redirect(back(r.error), 303);
  return c.redirect(back(r.calendarFound ? "bagli" : "takvimyok"), 303);
});

adminGoogle.post("/ayarlar", async (c) => {
  const body = await c.req.parseBody({ all: true });
  const one = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const many = (v: unknown) => (Array.isArray(v) ? v : v === undefined ? [] : [v]).map(one).filter(Boolean);
  let cals;
  try {
    cals = await listCalendars(c.env);
  } catch {
    return c.redirect(back("hata"), 303);
  }
  const target = one(body.takvim);
  if (!cals.some((x) => x.id === target && isWritable(x))) return c.redirect(back("gecersiz"), 303);
  const known = new Set(cals.map((x) => x.id));
  const busy = many(body.dolu).filter((id) => known.has(id));
  // A calendar not in the list (shared free/busy only, never added): its address.
  const extra = one(body.ek).toLowerCase();
  if (extra) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(extra)) return c.redirect(back("gecersiz"), 303);
    busy.push(extra);
  }
  // Keep manually added addresses that are still ticked.
  const prev = (await getGoogleSettings(c.env.DB)).busy.filter((id) => !known.has(id));
  busy.push(...many(body.dolu).filter((id) => prev.includes(id)));
  await saveCalendarChoices(c.env.DB, target, busy);
  return c.redirect(back("kaydedildi"), 303);
});

adminGoogle.post("/kes", async (c) => {
  const body = await c.req.parseBody();
  if (!body.onay) return c.redirect(back("onay"), 303);
  await disconnect(c.env);
  return c.redirect(back("kesildi"), 303);
});
