import { sql } from "drizzle-orm";
import { bigint, check, customType, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * Fulfillment tables — private to the fulfillment module. All refs to orders/users/inventory/suppliers are opaque ids
 * (cross-module FKs in SQL, P-1). The payment gate trigger needs the orders table and is installed in 2b-8.
 */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });
const ts = (n: string) => timestamp(n, { withTimezone: true });

export const fulfillmentTasks = pgTable(
  "fulfillment_tasks",
  {
    id: uuid("id").primaryKey(),
    orderRef: text("order_ref").notNull(),
    orderItemRef: text("order_item_ref").notNull(),
    userRef: text("user_ref").notNull(),
    variantId: uuid("variant_id").notNull(),
    method: text("method").notNull(),
    status: text("status").notNull().default("PENDING"),
    assignee: text("assignee"),
    attempt: integer("attempt").notNull().default(0),
    lastError: text("last_error"),
    supplierOrderId: uuid("supplier_order_id"),
    /** Opaque proof reference that the order was PAID (checked by the 2b-8 trigger). */
    paymentRef: text("payment_ref").notNull(),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
    completedAt: ts("completed_at"),
  },
  (t) => [
    uniqueIndex("fulfillment_tasks_item_uq").on(t.orderItemRef),
    check("fulfillment_tasks_method", sql`${t.method} in ('AUTO_CODE','MANUAL','SUPPLIER_API')`),
    check("fulfillment_tasks_status", sql`${t.status} in ('PENDING','PROCESSING','COMPLETED','FAILED','CANCELLED')`),
    check("fulfillment_tasks_completed", sql`(${t.status} = 'COMPLETED') = (${t.completedAt} is not null)`),
    check("fulfillment_tasks_processing_manual", sql`${t.status} <> 'PROCESSING' or ${t.method} <> 'MANUAL' or ${t.assignee} is not null`),
    index("fulfillment_tasks_queue_idx").on(t.method, t.createdAt).where(sql`${t.status} in ('PENDING','FAILED')`),
    index("fulfillment_tasks_order_idx").on(t.orderRef),
  ],
);

export const fulfillmentEvents = pgTable(
  "fulfillment_events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    taskId: uuid("task_id").notNull().references(() => fulfillmentTasks.id),
    type: text("type").notNull(),
    detail: text("detail"),
    actor: text("actor").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [index("fulfillment_events_task_idx").on(t.taskId, t.id)],
);

export const deliveries = pgTable(
  "deliveries",
  {
    id: uuid("id").primaryKey(),
    orderItemRef: text("order_item_ref").notNull(),
    userRef: text("user_ref").notNull(),
    kind: text("kind").notNull(),
    /** For inventory-backed deliveries: the sold digital code (opaque id into inventory). */
    codeRef: uuid("code_ref"),
    deliveredAt: ts("delivered_at").notNull(),
    firstRevealedAt: ts("first_revealed_at"),
    firstRevealedByType: text("first_revealed_by_type"),
    lastRevealedAt: ts("last_revealed_at"),
    revealCount: integer("reveal_count").notNull().default(0),
  },
  (t) => [
    uniqueIndex("deliveries_item_uq").on(t.orderItemRef),
    check("deliveries_kind", sql`${t.kind} in ('INVENTORY_CODE','SUPPLIER_CODE','MANUAL_CREDENTIAL')`),
    check("deliveries_code_ref", sql`(${t.kind} = 'INVENTORY_CODE') = (${t.codeRef} is not null)`),
    check("deliveries_reveal", sql`${t.revealCount} >= 0 and ((${t.revealCount} = 0) = (${t.firstRevealedAt} is null))`),
    check("deliveries_first_by", sql`${t.firstRevealedByType} is null or ${t.firstRevealedByType} in ('CUSTOMER','ADMIN')`),
    index("deliveries_user_idx").on(t.userRef, t.deliveredAt.desc()),
  ],
);

/** Secrets that do not live in inventory (supplier-returned or manually entered). Envelope only. */
export const deliverySecrets = pgTable(
  "delivery_secrets",
  {
    id: uuid("id").primaryKey(),
    deliveryId: uuid("delivery_id").notNull().references(() => deliveries.id),
    sealed: bytea("sealed").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [uniqueIndex("delivery_secrets_delivery_uq").on(t.deliveryId)],
);

export const secretAccessLog = pgTable(
  "secret_access_log",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    deliveryId: uuid("delivery_id").notNull().references(() => deliveries.id),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    check("secret_access_log_actor", sql`${t.actorType} in ('CUSTOMER','ADMIN')`),
    check("secret_access_log_action", sql`${t.action} in ('REVEAL','ADMIN_REVEAL')`),
    index("secret_access_log_delivery_idx").on(t.deliveryId, t.id),
  ],
);
