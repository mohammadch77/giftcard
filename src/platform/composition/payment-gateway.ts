import type { Env } from "../config";
import { DomainError } from "../errors";
import { NullPaymentGateway } from "../payment-gateway";
import type { PaymentGateway } from "../payment-gateway";
import { TestPaymentGateway } from "../payment-gateway/testing/test-gateway";

type GatewayEnv = Pick<Env, "NODE_ENV" | "PAYMENT_GATEWAY">;

/** GUARDED FACTORY: the scriptable test gateway is refused in production even if env validation is bypassed. No real adapter exists (X1). */
export function createPaymentGateway(env: GatewayEnv): PaymentGateway {
  if (env.PAYMENT_GATEWAY === "test") {
    if (env.NODE_ENV === "production") throw new DomainError("PAYMENT_GATEWAY_FORBIDDEN", "the test payment gateway is forbidden in production");
    return new TestPaymentGateway();
  }
  return new NullPaymentGateway();
}
