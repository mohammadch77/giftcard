import { sql } from "drizzle-orm";
import type { VariantUsageProbe } from "@/modules/catalog";

/** C-2 usage probe: active supplier routes and unresolved supplier orders for the variant. Read-only. */
export const supplierVariantUsage: VariantUsageProbe = async (tx, variantId) => {
  const routes = await tx.execute(sql`select count(*)::int as n from variant_supplier_routes where variant_id = ${variantId}::uuid and active`);
  return { source: "suppliers", open: { activeRoutes: (routes.rows[0] as { n: number }).n } };
};
