import { sql } from "drizzle-orm";
import type { Database } from "@/platform/db";
import { DomainError } from "@/platform/errors";
import { isUuid } from "@/platform/ids";
import type { HoldReason, OrderStatus, PaymentMethod } from "../domain/types";
import { ORDER_COLS, first, toDate } from "./core";
import type { OrderRow } from "./core";

export interface OrderItemView { lineNo: number; variantId: string; quantity: number; unitPrice: number; lineTotal: number; snapshot: unknown }
export interface OrderView { id: string; number: string; status: OrderStatus; paymentStatus: string; paymentMethod: PaymentMethod; total: number; expiresAt: Date; paidAt: Date | null; items: OrderItemView[]; /** true while a human is settling it; internal hold reasons are not exposed to customers */ underReview: boolean }

async function build(db: Database, o: OrderRow): Promise<OrderView> {
  const items = (await db.execute(sql`select line_no, variant_id, quantity, unit_price, line_total, snapshot from order_items where order_id = ${o.id} order by line_no`)).rows as { line_no: number; variant_id: string; quantity: number; unit_price: string; line_total: string; snapshot: unknown }[];
  return {
    id: o.id, number: o.number, status: o.status, paymentStatus: o.payment_status, paymentMethod: o.payment_method, total: Number(o.total), expiresAt: toDate(o.expires_at), paidAt: o.paid_at ? toDate(o.paid_at) : null,
    items: items.map((i) => ({ lineNo: i.line_no, variantId: i.variant_id, quantity: i.quantity, unitPrice: Number(i.unit_price), lineTotal: Number(i.line_total), snapshot: i.snapshot })),
    underReview: o.status === "ON_HOLD",
  };
}

/** Owner-scoped read: another user's order is indistinguishable from a missing one (IDOR-safe). Order numbers are random, not sequential. */
export async function getOrder(db: Database, userId: string, orderId: string): Promise<OrderView | null> {
  if (!isUuid(orderId)) return null;
  const o = first<OrderRow>(await db.execute(sql`select ${ORDER_COLS} from orders where id = ${orderId} and user_ref = ${userId}`));
  return o ? build(db, o) : null;
}

export async function listOrdersForUser(db: Database, userId: string, opts: { limit?: number } = {}): Promise<OrderView[]> {
  const rows = (await db.execute(sql`select ${ORDER_COLS} from orders where user_ref = ${userId} order by created_at desc limit ${Math.min(opts.limit ?? 20, 100)}`)).rows as unknown as OrderRow[];
  return Promise.all(rows.map((r) => build(db, r)));
}

export interface OrdersAdminContext { db: Database; authorize(permission: string): Promise<void> }
export interface OrderAdminView extends OrderView { userRef: string; holds: { id: string; reason: HoldReason; resolved: boolean }[] }

export async function getOrderAdmin(c: OrdersAdminContext, orderId: string): Promise<OrderAdminView> {
  await c.authorize("orders.read");
  const o = first<OrderRow>(await c.db.execute(sql`select ${ORDER_COLS} from orders where id = ${orderId}`));
  if (!o) throw new DomainError("ORDER_NOT_FOUND", "order not found");
  const holds = (await c.db.execute(sql`select id, reason, resolved_at is not null as resolved from order_holds where order_id = ${orderId} order by opened_at`)).rows as { id: string; reason: HoldReason; resolved: boolean }[];
  return { ...(await build(c.db, o)), userRef: o.user_ref, holds };
}

/** Open holds queue for the review desk. */
export async function listOpenHolds(c: OrdersAdminContext, limit = 50): Promise<{ id: string; orderId: string; reason: HoldReason }[]> {
  await c.authorize("orders.read");
  const r = await c.db.execute(sql`select id, order_id, reason from order_holds where resolved_at is null order by opened_at limit ${Math.min(limit, 200)}`);
  return (r.rows as { id: string; order_id: string; reason: HoldReason }[]).map((x) => ({ id: x.id, orderId: x.order_id, reason: x.reason }));
}
