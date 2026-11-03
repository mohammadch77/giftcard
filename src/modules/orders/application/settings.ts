import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "@/modules/audit";
import type { AuditActor } from "@/modules/audit";
import type { Clock } from "@/platform/clock";
import type { Database, Tx } from "@/platform/db";
import { withTransaction } from "@/platform/db";
import { DomainError } from "@/platform/errors";
import { uuidv7 } from "@/platform/ids";
import { parseSetting, requireReason } from "@/platform/settings";
import type { SettingVersion } from "@/platform/settings";

/**
 * ORDER SETTINGS (ADM-1, B3) — owned by the orders module. A typed, append-only version table; one column per setting.
 *  - reservation TTL: 60–3600 s (bounds enforced here AND by a DB CHECK), initial value 900 s (owner-approved B3, version 1 by migration).
 *  - A change is a NEW version (actor, reason, previous → new, audit in the SAME transaction). It affects only FUTURE checkouts: an order
 *    stores the TTL it used in its policy snapshot and a reservation's expiry is fixed at creation (D9) — nothing existing is touched.
 *  - Fail closed: if no valid version can be read, checkout is refused (ORDER_RESERVATION_TTL_NOT_CONFIGURED).
 * Not financial => one administrator with the sensitive (step-up) permission `orders.settings.manage`.
 */
export const RESERVATION_TTL_BOUNDS = { min: 60, max: 3600 } as const;

const ttlSchema = z.strictObject({ reservationTtlSeconds: z.number().int().min(RESERVATION_TTL_BOUNDS.min).max(RESERVATION_TTL_BOUNDS.max) });
export type OrderSettingValues = z.infer<typeof ttlSchema>;
export type OrderSettings = SettingVersion<OrderSettingValues>;

interface Row { version: number; reservation_ttl_seconds: number; source: "SEED" | "ADMIN" }
const notConfigured = (): DomainError => new DomainError("ORDER_RESERVATION_TTL_NOT_CONFIGURED", "the checkout reservation hold is not configured (setting B3)");

/** The ACTIVE order settings (highest version). Pass a transaction to read them consistently with the rest of checkout. */
export async function getOrderSettings(db: Database | Tx): Promise<OrderSettings> {
  const r = (await db.execute(sql`select version, reservation_ttl_seconds, source from order_settings_versions order by version desc limit 1`)).rows[0] as Row | undefined;
  if (!r) throw notConfigured();
  const parsed = ttlSchema.safeParse({ reservationTtlSeconds: r.reservation_ttl_seconds });
  if (!parsed.success) throw notConfigured(); // a stored value outside the bounds is never used
  return { version: r.version, values: parsed.data, source: r.source };
}

export interface OrderSettingsAdmin { db: Database; clock: Clock; actor: AuditActor; authorize(permission: string): Promise<void> }

export async function getOrderSettingsAdmin(c: Pick<OrderSettingsAdmin, "db" | "authorize">): Promise<OrderSettings> {
  await c.authorize("orders.settings.read");
  return getOrderSettings(c.db);
}

/** Change the reservation TTL. Audited with old and new value in the same transaction; affects future checkouts only. */
export async function setReservationTtl(c: OrderSettingsAdmin, input: { reservationTtlSeconds: number; reason: string }): Promise<{ version: number; previousVersion: number }> {
  await c.authorize("orders.settings.manage");
  const values = parseSetting(ttlSchema, { reservationTtlSeconds: input.reservationTtlSeconds });
  const reason = requireReason(input.reason);
  return withTransaction(c.db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('order_settings_versions', 0))`); // serialises version numbering
    const cur = await getOrderSettings(tx);
    if (cur.values.reservationTtlSeconds === values.reservationTtlSeconds) throw new DomainError("SETTINGS_INVALID", "the reservation TTL already has this value");
    const version = cur.version + 1;
    const id = uuidv7(c.clock);
    await tx.execute(sql`insert into order_settings_versions (id, version, reservation_ttl_seconds, source, previous_version, changed_by, reason, created_at)
      values (${id}, ${version}, ${values.reservationTtlSeconds}, 'ADMIN', ${cur.version}, ${c.actor.id}, ${reason}, ${c.clock.now().toISOString()}::timestamptz)`);
    await recordAudit(tx, {
      actor: c.actor, action: "orders.settings.reservation_ttl_changed", entity: { type: "order_settings", id },
      before: { version: cur.version, reservationTtlSeconds: cur.values.reservationTtlSeconds }, after: { version, reservationTtlSeconds: values.reservationTtlSeconds },
      metadata: { reason }, occurredAt: c.clock.now(),
    });
    return { version, previousVersion: cur.version };
  });
}
