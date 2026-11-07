import { createMiddleware } from "hono/factory";
import { isDevEnvironment, type AppEnv } from "../env";
import { verifyAccessJwt, type KeySource } from "./access";
import { findAdmin, parseAdmins } from "./admins";

/** Overridable in tests. */
export const accessKeys: { source?: KeySource } = {};

export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  const admins = parseAdmins(c.env.ADMIN_EMAILS);
  let email: string | null;
  if (isDevEnvironment(c.env)) {
    // Local/test only: no Access in front. Act as the first configured admin.
    email = admins[0]?.email ?? null;
  } else {
    email = await verifyAccessJwt(c.req.header("cf-access-jwt-assertion"), {
      teamDomain: c.env.ACCESS_TEAM_DOMAIN,
      aud: c.env.ACCESS_AUD,
      keys: accessKeys.source,
    });
  }
  const admin = email ? findAdmin(admins, email) : undefined;
  if (!admin) return c.text("Erişim yok.", 403);
  c.set("admin", admin);
  c.header("Cache-Control", "no-store");
  c.header("X-Robots-Tag", "noindex, nofollow");
  await next();
});
