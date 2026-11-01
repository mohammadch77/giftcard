import { z } from "zod";

/**
 * Environment validation. The ONLY module that reads process.env (enforced by ESLint).
 * The process must refuse to start when this fails — never fall back silently.
 *
 * Providers (payment / SMS / supplier) are intentionally not selected yet (D3-D5):
 * the only legal values are "none" and "test"; "test" is forbidden in production.
 */
const providerSetting = z.enum(["none", "test"]).default("none");

const postgresUrl = z
  .string()
  .min(1)
  .refine((v) => /^postgres(ql)?:\/\//.test(v), "must be a postgres:// or postgresql:// URL");

const baseSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.url().default("http://localhost:3000"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  DATABASE_URL: postgresUrl,
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  MIGRATION_DATABASE_URL: postgresUrl.optional(),

  PAYMENT_GATEWAY: providerSetting,
  SMS_PROVIDER: providerSetting,
  SUPPLIER_ADAPTERS: providerSetting,

  // Initial value 5 minutes, configurable. Only extends a reservation while a payment is
  // VERIFYING; it never allows using an expired reservation (see DATABASE_DESIGN §5.5).
  PAYMENT_VERIFY_GRACE_SECONDS: z.coerce.number().int().min(0).max(1800).default(300),
});

export const envSchema = baseSchema.superRefine((env, ctx) => {
  if (env.NODE_ENV !== "production") return;
  for (const key of ["PAYMENT_GATEWAY", "SMS_PROVIDER", "SUPPLIER_ADAPTERS"] as const) {
    if (env[key] === "test") {
      ctx.addIssue({ code: "custom", path: [key], message: "test doubles are forbidden in production" });
    }
  }
  if (!env.APP_URL.startsWith("https://")) {
    ctx.addIssue({ code: "custom", path: ["APP_URL"], message: "must be https in production" });
  }
});

export type Env = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  constructor(public readonly issues: ReadonlyArray<{ path: string; message: string }>) {
    // Messages list variable names and reasons only — never values (they may be secrets).
    super(`Invalid environment configuration:\n${issues.map((i) => `  - ${i.path}: ${i.message}`).join("\n")}`);
    this.name = "EnvValidationError";
  }
}

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((i) => ({ path: i.path.join(".") || "(root)", message: i.message })),
    );
  }
  return result.data;
}

let cached: Env | undefined;

/** Validated, memoised configuration for the running process. */
export function loadEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}

/** Test helper: forget the memoised value. */
export function resetEnvCacheForTests(): void {
  cached = undefined;
}
