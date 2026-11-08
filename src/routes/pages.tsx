import { Hono } from "hono";
import type { AppEnv } from "../env";

/** Dynamic customer pages that are not part of a feature router. Static pages live in public/. */
export const pages = new Hono<AppEnv>();
