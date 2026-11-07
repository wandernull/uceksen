import { Hono } from "hono";
import type { AppEnv } from "./env";
import { health } from "./routes/health";

const app = new Hono<AppEnv>();

app.route("/health", health);

export default app;
