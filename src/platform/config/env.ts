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

/** 32 random bytes, base64 (standard or url-safe). Value is never echoed in error messages. */
const key32 = z
  .string()
  .refine((v) => {
    try {
      return Buffer.from(v, "base64").length === 32;
    } catch {
      return false;
    }
  }, "must be 32 random bytes, base64-encoded")
  .optional();

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

  // Key custody (D8 is OPEN). 'none' = crypto features fail closed. 'dev' = in-memory development
  // provider fed by DEV_* variables; FORBIDDEN in production. No real key may be placed here.
  KEY_PROVIDER: z.enum(["none", "dev"]).default("none"),
  DEV_KEK_V1: key32,
  DEV_KEK_V2: key32,
  DEV_PEPPER_V1: key32,
  DEV_PEPPER_V2: key32,

  // Wallet top-up limits (B5 is OPEN: NO default exists). Unset = top-ups fail closed (WALLET_LIMITS_NOT_CONFIGURED).
  WALLET_TOPUP_MIN_RIAL: z.coerce.number().int().positive().optional(),
  WALLET_TOPUP_MAX_RIAL: z.coerce.number().int().positive().optional(),

  // Checkout reservation hold in seconds (B3 is OPEN: NO default exists). Unset = checkout fails closed
  // (ORDER_RESERVATION_TTL_NOT_CONFIGURED). The inventory module's 900 s is a technical default, not a business value.
  ORDER_RESERVATION_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).optional(),

  // Worker / outbox tuning (platform, no business meaning).
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(1000),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(20),

  // Late-payment HANDLING policy window (D9, APPROVED): initial 300 s, configurable.
  // It does NOT extend any reservation TTL and never allows using an expired reservation
  // or delivering without a (new) reservation. See DATABASE_DESIGN §5.5.
  LATE_PAYMENT_HANDLING_WINDOW_SECONDS: z.coerce.number().int().min(0).max(1800).default(300),
});

export const envSchema = baseSchema.superRefine((env, ctx) => {
  if (env.KEY_PROVIDER === "dev") {
    if (!env.DEV_KEK_V1 || !env.DEV_PEPPER_V1) {
      ctx.addIssue({ code: "custom", path: ["KEY_PROVIDER"], message: "dev provider requires DEV_KEK_V1 and DEV_PEPPER_V1" });
    }
    const values = [env.DEV_KEK_V1, env.DEV_KEK_V2, env.DEV_PEPPER_V1, env.DEV_PEPPER_V2].filter((v): v is string => Boolean(v));
    if (new Set(values).size !== values.length) {
      ctx.addIssue({ code: "custom", path: ["DEV_KEK_V1"], message: "KEKs and peppers must all be distinct secrets" });
    }
  }
  if (env.NODE_ENV !== "production") return;
  if (env.KEY_PROVIDER === "dev") {
    ctx.addIssue({ code: "custom", path: ["KEY_PROVIDER"], message: "the development key provider is forbidden in production" });
  }
  for (const key of ["DEV_KEK_V1", "DEV_KEK_V2", "DEV_PEPPER_V1", "DEV_PEPPER_V2"] as const) {
    if (env[key] !== undefined) {
      ctx.addIssue({ code: "custom", path: [key], message: "development key material must not be set in production" });
    }
  }
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
