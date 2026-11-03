import { sql } from "drizzle-orm";
import type { VariantUsageProbe } from "@/modules/catalog";

/** C-2 usage probe: orders containing the variant that are not final (unpaid, being fulfilled or on hold). Completed, cancelled and expired orders keep their own snapshot and do not block. Read-only. */
export const orderVariantUsage: VariantUsageProbe = async (tx, variantId) => {
  const r = await tx.execute(
    sql`select count(distinct o.id)::int as n from orders o join order_items i on i.order_id = o.id
         where i.variant_id = ${variantId}::uuid and o.status in ('PENDING_PAYMENT','PAID','FULFILLING','PARTIALLY_COMPLETED','ON_HOLD')`,
  );
  return { source: "orders", open: { openOrders: (r.rows[0] as { n: number }).n } };
};
