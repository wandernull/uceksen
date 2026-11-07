export type Environment = "local" | "test" | "staging" | "production";

export type AppEnv = { Bindings: Env };

export function isProduction(env: Pick<Env, "ENVIRONMENT">): boolean {
  return env.ENVIRONMENT === "production";
}
