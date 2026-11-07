import { Hono } from "hono";
import type { AppEnv } from "./env";
import { admin } from "./routes/admin/conversations";
import { health } from "./routes/health";
import { pages } from "./routes/pages";
import { talep } from "./routes/talep";

const app = new Hono<AppEnv>();

app.route("/health", health);
app.route("/api/talep", talep);
app.route("/admin", admin);
app.route("/", pages);

// In production, matching static files never reach the Worker. Unmatched paths
// (and every request in the test runtime) are handed to the assets binding.
app.notFound((c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
