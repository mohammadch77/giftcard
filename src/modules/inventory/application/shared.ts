import { sql } from "drizzle-orm";
import type { Tx } from "@/platform/db";

export type Ts = Date | string;
export const iso = (d: Date): string => d.toISOString();
export const first = <T>(r: { rows: unknown[] }): T | undefined => r.rows[0] as T | undefined;

export interface MovementRow { variantId: string; codeId?: string | null; reservationId?: string | null; type: string; qtyDelta: number; orderItemRef?: string | null; reason?: string | null }

/** Append movement rows (the audit trail of stock changes). Chunked multi-row insert. */
export async function addMovements(tx: Tx, rows: readonly MovementRow[], actor: string, now: Date): Promise<void> {
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    await tx.execute(
      sql`insert into inventory_movements (variant_id, code_id, reservation_id, type, qty_delta, order_item_ref, reason, actor, created_at) values ${sql.join(
        chunk.map((m) => sql`(${m.variantId}::uuid, ${m.codeId ?? null}::uuid, ${m.reservationId ?? null}::uuid, ${m.type}, ${m.qtyDelta}, ${m.orderItemRef ?? null}, ${m.reason ?? null}, ${actor}, ${iso(now)}::timestamptz)`),
        sql`, `,
      )}`,
    );
  }
}
