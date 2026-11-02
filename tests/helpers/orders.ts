import { importCodes } from "@/modules/inventory";
import { checkout } from "@/modules/orders";
import type { OrdersAdminContext, OrdersDeps } from "@/modules/orders";
import { TestPostingPolicy } from "@/modules/orders/testing/test-posting-policy";
import { DomainError } from "@/platform/errors";
import { TestPaymentGateway } from "@/platform/payment-gateway/testing/test-gateway";
import { invCtx, makeCodes, sellableVariant } from "./inventory";
import { supplierFixture } from "./suppliers";
import type { SupplierFixture } from "./suppliers";

export interface OrderFixture extends SupplierFixture { gateway: TestPaymentGateway; policy: TestPostingPolicy; deps: SupplierFixture["deps"] & OrdersDeps }

export async function orderFixture(): Promise<OrderFixture> {
  const base = await supplierFixture();
  const gateway = new TestPaymentGateway();
  const policy = new TestPostingPolicy();
  const deps = { ...base.deps, db: base.app.db, clock: base.clock, gateway, policy, reservationTtlSeconds: 900 };
  return { ...base, gateway, policy, deps } as OrderFixture;
}

export const ordersDeps = (f: OrderFixture, over: Partial<OrdersDeps> = {}): OrdersDeps => ({ db: f.app.db, clock: f.clock, gateway: f.gateway, policy: f.policy, reservationTtlSeconds: 900, ...over });

export function adminOf(f: OrderFixture, actorId = "admin-1", allowed: "all" | string[] = "all") {
  return {
    actor: { type: "ADMIN" as const, id: actorId },
    authorize: async (p: string) => {
      if (allowed !== "all" && !allowed.includes(p)) throw new DomainError("AUTH_FORBIDDEN", "no");
    },
    ctx: { db: f.app.db, authorize: async (p: string) => { if (allowed !== "all" && !allowed.includes(p)) throw new DomainError("AUTH_FORBIDDEN", "no"); } } as OrdersAdminContext,
  };
}

/** A sellable AUTO_CODE variant with `n` imported codes. */
export async function stockedVariant(f: OrderFixture, n: number): Promise<{ variantId: string; codes: string[] }> {
  const variantId = await sellableVariant(f, "AUTO_CODE");
  const codes = makeCodes(n);
  if (n) await importCodes(invCtx(f), variantId, { payloadKind: "CODE", codes });
  return { variantId, codes };
}

let n = 0;
export const uniqKey = () => `ck-${++n}-${Math.random().toString(36).slice(2, 7)}`;
export const userId = () => `user-${++n}-${Math.random().toString(36).slice(2, 5)}`;

export async function gatewayCheckout(f: OrderFixture, user: string, lines: { variantId: string; quantity: number }[], over: Partial<OrdersDeps> = {}) {
  const r = await checkout(ordersDeps(f, over), { userId: user, paymentMethod: "GATEWAY", idempotencyKey: uniqKey(), lines });
  const gatewayRef = r.paymentId ? ((await f.t.pool.query("select gateway_ref from payments where id = $1", [r.paymentId])).rows[0].gateway_ref as string) : "";
  return { ...r, gatewayRef };
}

export const orderRow = async (f: OrderFixture, id: string) => (await f.t.pool.query("select * from orders where id = $1", [id])).rows[0];
