import type { WalletAdminContext } from "@/modules/wallet";
import { ManualClock } from "@/platform/clock/testing";
import { DomainError } from "@/platform/errors";
import { TestPaymentGateway } from "@/platform/payment-gateway/testing/test-gateway";
import { completeTopUp, startTopUp } from "@/modules/wallet";
import type { DatabaseHandle } from "@/platform/db";
import { createDatabaseAsRole, createTestDatabase, createTestRoles } from "./db";
import type { TestDatabase } from "./db";

export interface PayFixture { t: TestDatabase; app: DatabaseHandle; clock: ManualClock; gateway: TestPaymentGateway }
export const LIMITS = { minRial: 10_000, maxRial: 100_000_000 };

export async function payFixture(): Promise<PayFixture> {
  const t = await createTestDatabase();
  const roles = await createTestRoles(t);
  return { t, app: createDatabaseAsRole(t, roles.appRole, 30), clock: new ManualClock("2026-06-01T10:00:00Z"), gateway: new TestPaymentGateway() };
}

export const deps = (f: PayFixture) => ({ gateway: f.gateway, clock: f.clock });

export function walletCtx(f: PayFixture, actorId: string, allowed: "all" | string[] = "all"): WalletAdminContext {
  return {
    db: f.app.db, clock: f.clock, actor: { type: "ADMIN", id: actorId },
    authorize: async (p) => {
      if (allowed !== "all" && !allowed.includes(p)) throw new DomainError("AUTH_FORBIDDEN", "not permitted");
    },
  };
}

let n = 0;
export const uid = (p = "user") => `${p}-${++n}-${Math.random().toString(36).slice(2, 6)}`;

/** Start a top-up and return the gateway reference used for callbacks. */
export async function startedTopUp(f: PayFixture, userId: string, amount: number, key = uid("k")) {
  const r = await startTopUp(f.app.db, deps(f), { userId, amount, idempotencyKey: key }, LIMITS);
  const gatewayRef = (await f.t.pool.query("select gateway_ref from payments where id = $1", [r.paymentId])).rows[0].gateway_ref as string;
  return { ...r, gatewayRef };
}

/** Full happy path: start, gateway confirms `paid` Rial, callback. */
export async function paidTopUp(f: PayFixture, userId: string, amount: number, paid = amount) {
  const t = await startedTopUp(f, userId, amount);
  f.gateway.script(t.gatewayRef, { status: "PAID", amount: paid });
  const out = await completeTopUp(f.app.db, deps(f), { gatewayRef: t.gatewayRef, eventKey: uid("ev") });
  return { ...t, out };
}
