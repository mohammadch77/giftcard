import { sql } from "drizzle-orm";
import type { VariantUsageProbe } from "@/modules/catalog";

/** C-2 usage probe: fulfilment tasks of the variant that are not final (a FAILED task still needs a human, so it counts). Read-only. */
export const fulfillmentVariantUsage: VariantUsageProbe = async (tx, variantId) => {
  const r = await tx.execute(sql`select count(*)::int as n from fulfillment_tasks where variant_id = ${variantId}::uuid and status in ('PENDING','PROCESSING','FAILED')`);
  return { source: "fulfillment", open: { openTasks: (r.rows[0] as { n: number }).n } };
};
