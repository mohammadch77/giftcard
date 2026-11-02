import { NullKeyProvider } from "../crypto";
import type { KeyProvider } from "../crypto";
import { DevKeyProvider } from "../crypto/testing/dev-key-provider";
import type { Env } from "../config";
import { DomainError } from "../errors";

/**
 * GUARDED FACTORY (P-5): the ONLY production-path file allowed to import a test/dev double
 * (dependency-cruiser exempts src/platform/composition/). It re-checks the production rule at
 * runtime in addition to env validation, so a bypassed validation still cannot start a dev provider.
 * D8 is open: no production KeyProvider exists yet — in production the only accepted value is
 * 'none' (fail closed) until a custody solution is approved and implemented.
 */
type KeyEnv = Pick<Env, "NODE_ENV" | "KEY_PROVIDER" | "DEV_KEK_V1" | "DEV_KEK_V2" | "DEV_PEPPER_V1" | "DEV_PEPPER_V2">;

const b64 = (v: string): Buffer => Buffer.from(v, "base64");

export function createKeyProvider(env: KeyEnv): KeyProvider {
  if (env.KEY_PROVIDER === "none") return new NullKeyProvider();

  if (env.NODE_ENV === "production") {
    throw new DomainError("KEY_PROVIDER_FORBIDDEN", "the development key provider is forbidden in production");
  }
  if (!env.DEV_KEK_V1 || !env.DEV_PEPPER_V1) {
    throw new DomainError("KEY_PROVIDER_NOT_CONFIGURED", "dev provider requires DEV_KEK_V1 and DEV_PEPPER_V1");
  }
  const keks = new Map<number, Buffer>([[1, b64(env.DEV_KEK_V1)]]);
  const peppers = new Map<number, Buffer>([[1, b64(env.DEV_PEPPER_V1)]]);
  if (env.DEV_KEK_V2) keks.set(2, b64(env.DEV_KEK_V2));
  if (env.DEV_PEPPER_V2) peppers.set(2, b64(env.DEV_PEPPER_V2));
  return new DevKeyProvider({ keks, peppers, currentKek: Math.max(...keks.keys()), currentPepper: Math.max(...peppers.keys()) });
}
