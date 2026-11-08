import { Hono } from "hono";
import type { AppEnv } from "./env";
import { admin } from "./routes/admin/conversations";
import { health } from "./routes/health";
import { konusma } from "./routes/konusma";
import { pages } from "./routes/pages";
import { talep } from "./routes/talep";
import { webhooks } from "./routes/webhooks";

// strict: false so "/admin/" (the URL Cloudflare Access protects) matches the "/admin" routes.
const app = new Hono<AppEnv>({ strict: false });

// Access's path rule "admin" covers "/admin/*" but not the bare "/admin", so send that
// to the canonical "/admin/". The Worker's own JWT check still guards every admin route.
app.use("*", async (c, next) => {
  const url = new URL(c.req.url);
  if (url.pathname === "/admin") return c.redirect(`/admin/${url.search}`, 301);
  await next();
});

app.route("/health", health);
app.route("/api/talep", talep);
app.route("/api/webhooks", webhooks);
app.route("/konusma", konusma);
app.route("/admin", admin);
app.route("/", pages);

// In production, matching static files never reach the Worker. Unmatched paths
// (and every request in the test runtime) are handed to the assets binding.
app.notFound((c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
