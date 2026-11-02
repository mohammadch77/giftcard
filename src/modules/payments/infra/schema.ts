import { sql } from "drizzle-orm";
import { bigint, char, check, customType, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * Payments tables — private to the payments module. order_ref / topup_ref / user_ref are OPAQUE ids (FKs to other
 * modules are not created, P-1). A payment is SUCCEEDED only from a verified server-to-server gateway reply whose
 * amount equals the payment amount (CHECK below). No card data is ever stored.
 */
const rialAmount = customType<{ data: number; driverData: string }>({
  dataType: () => "rial_amount",
  toDriver: (v) => String(v),
  fromDriver: (v) => Number(v),
});
const ts = (n: string) => timestamp(n, { withTimezone: true });
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey(),
    purpose: text("purpose").notNull(),
    orderRef: text("order_ref"),
    topupRef: text("topup_ref"),
    userRef: text("user_ref").notNull(),
    gateway: text("gateway").notNull(),
    gatewayRef: text("gateway_ref"),
    amount: rialAmount("amount").notNull(),
    currency: char("currency", { length: 3 }).notNull().default("IRR"),
    status: text("status").notNull().default("INITIATED"),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: bytea("request_hash").notNull(),
    verifyingSince: ts("verifying_since"),
    verifyAttempts: integer("verify_attempts").notNull().default(0),
    verifiedAt: ts("verified_at"),
    verifiedAmount: rialAmount("verified_amount"),
    reviewReason: text("review_reason"),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [
    check("payments_purpose", sql`${t.purpose} in ('ORDER','WALLET_TOPUP')`),
    check("payments_one_target", sql`(${t.purpose} = 'ORDER' and ${t.orderRef} is not null and ${t.topupRef} is null) or (${t.purpose} = 'WALLET_TOPUP' and ${t.topupRef} is not null and ${t.orderRef} is null)`),
    check("payments_amount_positive", sql`${t.amount} > 0`),
    check("payments_currency", sql`${t.currency} = 'IRR'`),
    check("payments_status", sql`${t.status} in ('INITIATED','PENDING','VERIFYING','SUCCEEDED','FAILED','NEEDS_REVIEW','EXPIRED','CANCELLED')`),
    check("payments_gateway_key", sql`${t.gateway} ~ '^[a-z][a-z0-9_-]{0,39}$'`),
    // SUCCEEDED is only possible with a verification time and a verified amount EQUAL to the payment amount.
    check("payments_succeeded_verified", sql`${t.status} <> 'SUCCEEDED' or (${t.verifiedAt} is not null and ${t.verifiedAmount} = ${t.amount} and ${t.gatewayRef} is not null)`),
    check("payments_pending_has_ref", sql`${t.status} not in ('PENDING','VERIFYING') or ${t.gatewayRef} is not null`),
    uniqueIndex("payments_idempotency_uq").on(t.idempotencyKey),
    uniqueIndex("payments_gateway_ref_uq").on(t.gateway, t.gatewayRef).where(sql`${t.gatewayRef} is not null`),
    index("payments_user_idx").on(t.userRef, t.createdAt.desc()),
    index("payments_order_idx").on(t.orderRef).where(sql`${t.orderRef} is not null`),
    index("payments_topup_idx").on(t.topupRef).where(sql`${t.topupRef} is not null`),
    index("payments_verifying_idx").on(t.verifyingSince).where(sql`${t.status} = 'VERIFYING'`),
  ],
);

export const paymentEvents = pgTable(
  "payment_events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    paymentId: uuid("payment_id").notNull().references(() => payments.id),
    gateway: text("gateway").notNull(),
    eventKey: text("event_key").notNull(),
    kind: text("kind").notNull(),
    /** Redacted before storage (platform/logging redact). */
    raw: jsonb("raw"),
    receivedAt: ts("received_at").notNull(),
  },
  (t) => [uniqueIndex("payment_events_dedupe_uq").on(t.gateway, t.eventKey), check("payment_events_kind", sql`${t.kind} in ('CALLBACK','VERIFY_REPLY')`), index("payment_events_payment_idx").on(t.paymentId)],
);

export const paymentStatusHistory = pgTable("payment_status_history", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  entityId: uuid("entity_id").notNull(),
  fromStatus: text("from_status"),
  toStatus: text("to_status").notNull(),
  actorId: text("actor_id"),
  reason: text("reason"),
  occurredAt: ts("occurred_at").notNull(),
});
