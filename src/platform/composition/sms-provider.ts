import type { Env } from "../config";
import { DomainError } from "../errors";
import { NullSmsProvider } from "../sms";
import type { SmsProvider } from "../sms";
import { TestSmsProvider } from "../sms/testing/test-sms";

type SmsEnv = Pick<Env, "NODE_ENV" | "SMS_PROVIDER">;

/**
 * GUARDED FACTORY: the test double is refused in production here even if env validation is bypassed.
 * No real provider exists (X2); production therefore fails closed (NullSmsProvider) until one is added.
 */
export function createSmsProvider(env: SmsEnv): SmsProvider {
  if (env.SMS_PROVIDER === "test") {
    if (env.NODE_ENV === "production") throw new DomainError("SMS_PROVIDER_FORBIDDEN", "the test SMS provider is forbidden in production");
    return new TestSmsProvider();
  }
  return new NullSmsProvider();
}
