import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { AuditActor } from "@/modules/audit";
import { withTransaction } from "@/platform/db";
import { DomainError } from "@/platform/errors";
import { uuidv7 } from "@/platform/ids";
import { getAdapter } from "@/platform/supplier-adapter";
import type { SupplierProductInfo } from "@/platform/supplier-adapter";
import { MAX_SYNC_ITEMS, normalizeProduct } from "../domain/rules";
import type { NormalizedProduct } from "../domain/rules";
import { audit, classifyError, first, iso, withCredentials } from "./shared";
import type { SupplierDeps } from "./shared";
import type { Database } from "@/platform/db";

export interface SyncResult { runId: string; status: "SUCCEEDED" | "FAILED"; fetched: number; created: number; updated: number; rejected: number; markedUnavailable: number; errorKind?: string }

const rawHash = (p: NormalizedProduct) => createHash("sha256").update(JSON.stringify([p.name, p.cost, p.available, p.stockHint])).digest();

/**
 * Synchronise supplier prices and availability. The adapter call happens OUTSIDE any transaction; its result is validated and
 * normalised (integer Rial in IRR only — anything else is rejected, no FX is invented), then applied in one transaction with a
 * change history. The adapter's listing is treated as COMPLETE: products missing from it become unavailable. A failed fetch
 * changes nothing and is recorded. Supplier cost never alters a catalog price (no pricing/COGS policy exists yet, D10).
 */
export async function syncSupplierProducts(db: Database, deps: SupplierDeps, actor: AuditActor, supplierId: string): Promise<SyncResult> {
  const sup = first<{ adapter_key: string; status: string }>(await db.execute(sql`select adapter_key, status from suppliers where id = ${supplierId}`));
  if (!sup) throw new DomainError("SUPPLIER_NOT_FOUND", "supplier not found");
  if (sup.status !== "ACTIVE") throw new DomainError("SUPPLIER_INVALID", "supplier is not active");
  const adapter = getAdapter(deps.adapters, sup.adapter_key);
  const runId = uuidv7(deps.clock);
  await withTransaction(db, (tx) =>
    tx.execute(sql`insert into supplier_sync_runs (id, supplier_id, status, started_by, started_at) values (${runId}, ${supplierId}, 'RUNNING', ${actor.id}, ${iso(deps.clock.now())}::timestamptz)`),
  );

  let listing: readonly SupplierProductInfo[] | null = null;
  let errorKind: string | undefined;
  try {
    listing = await withCredentials(db, deps.keys, supplierId, (cred) => adapter.listProducts(cred));
  } catch (e) {
    if (e instanceof DomainError && (e.code === "SUPPLIER_INVALID" || e.code === "KEY_PROVIDER_NOT_CONFIGURED" || e.code === "KEY_UNAVAILABLE")) errorKind = e.code;
    else errorKind = classifyError(e);
  }
  if (!listing || listing.length > MAX_SYNC_ITEMS) {
    const kind = errorKind ?? "TOO_LARGE";
    await withTransaction(db, async (tx) => {
      await tx.execute(sql`update supplier_sync_runs set status = 'FAILED', error_kind = ${kind}, finished_at = ${iso(deps.clock.now())}::timestamptz where id = ${runId}`);
      await audit(tx, actor, deps.clock.now(), "suppliers.sync.failed", { type: "supplier", id: supplierId }, { errorKind: kind });
    });
    return { runId, status: "FAILED", fetched: 0, created: 0, updated: 0, rejected: 0, markedUnavailable: 0, errorKind: kind };
  }

  const items = new Map<string, NormalizedProduct>();
  let rejected = 0;
  for (const raw of listing) {
    const n = normalizeProduct(raw);
    if (!n || items.has(n.externalSku)) rejected++;
    else items.set(n.externalSku, n);
  }
  return withTransaction(db, async (tx): Promise<SyncResult> => {
    const now = deps.clock.now();
    const existing = new Map(
      (await tx.execute(sql`select id, external_sku, cost, available, raw_hash from supplier_products where supplier_id = ${supplierId} for update`)).rows
        .map((r) => r as { id: string; external_sku: string; cost: string; available: boolean; raw_hash: Buffer })
        .map((r) => [r.external_sku, r] as const),
    );
    let created = 0, updated = 0, markedUnavailable = 0;
    const stamp = iso(now);
    for (const [sku, p] of items) {
      const cur = existing.get(sku);
      const hash = rawHash(p);
      if (!cur) {
        const id = uuidv7(deps.clock);
        await tx.execute(sql`insert into supplier_products (id, supplier_id, external_sku, name, cost, available, stock_hint, raw_hash, last_synced_at, created_at) values (${id}, ${supplierId}, ${sku}, ${p.name}, ${p.cost}, ${p.available}, ${p.stockHint}, ${hash}, ${stamp}::timestamptz, ${stamp}::timestamptz)`);
        await tx.execute(sql`insert into supplier_product_changes (supplier_product_id, run_id, old_cost, new_cost, old_available, new_available, changed_at) values (${id}, ${runId}, null, ${p.cost}, null, ${p.available}, ${stamp}::timestamptz)`);
        created++;
      } else if (!Buffer.from(cur.raw_hash).equals(hash)) {
        await tx.execute(sql`update supplier_products set name = ${p.name}, cost = ${p.cost}, available = ${p.available}, stock_hint = ${p.stockHint}, raw_hash = ${hash}, last_synced_at = ${stamp}::timestamptz where id = ${cur.id}`);
        if (Number(cur.cost) !== p.cost || cur.available !== p.available) {
          await tx.execute(sql`insert into supplier_product_changes (supplier_product_id, run_id, old_cost, new_cost, old_available, new_available, changed_at) values (${cur.id}, ${runId}, ${Number(cur.cost)}, ${p.cost}, ${cur.available}, ${p.available}, ${stamp}::timestamptz)`);
        }
        updated++;
      } else {
        await tx.execute(sql`update supplier_products set last_synced_at = ${stamp}::timestamptz where id = ${cur.id}`);
      }
    }
    for (const [sku, cur] of existing) {
      if (items.has(sku) || !cur.available) continue;
      await tx.execute(sql`update supplier_products set available = false, last_synced_at = ${stamp}::timestamptz where id = ${cur.id}`);
      await tx.execute(sql`insert into supplier_product_changes (supplier_product_id, run_id, old_cost, new_cost, old_available, new_available, changed_at) values (${cur.id}, ${runId}, ${Number(cur.cost)}, ${Number(cur.cost)}, true, false, ${stamp}::timestamptz)`);
      markedUnavailable++;
    }
    await tx.execute(sql`update supplier_sync_runs set status = 'SUCCEEDED', fetched = ${listing.length}, created = ${created}, updated = ${updated}, rejected = ${rejected}, finished_at = ${stamp}::timestamptz where id = ${runId}`);
    await audit(tx, actor, now, "suppliers.sync.completed", { type: "supplier", id: supplierId }, { fetched: listing.length, created, updated, rejected, markedUnavailable });
    return { runId, status: "SUCCEEDED", fetched: listing.length, created, updated, rejected, markedUnavailable };
  });
}
