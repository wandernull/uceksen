export type Environment = "local" | "test" | "staging" | "production";

export type Author = "gizem" | "baran";
export type Admin = { email: string; author: Author };

export type AppEnv = { Bindings: Env; Variables: { admin: Admin } };

export function isProduction(env: Pick<Env, "ENVIRONMENT">): boolean {
  return env.ENVIRONMENT === "production";
}

/** Only these never-deployed environments may skip Cloudflare Access. */
export function isDevEnvironment(env: Pick<Env, "ENVIRONMENT">): boolean {
  return env.ENVIRONMENT === "local" || env.ENVIRONMENT === "test";
}
