import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { changePrice, createVariant, setProductStatus, setVariantStatus } from "@/modules/catalog";
import { quote } from "@/modules/pricing";
import { withTransaction } from "@/platform/db";
import { adminCtx, catalogFixture, seedBase, uniq } from "../helpers/catalog";
import type { CatalogFixture } from "../helpers/catalog";

let f: CatalogFixture;
let ids: { a: string; b: string };
beforeAll(async () => {
  f = await catalogFixture();
  const c = adminCtx(f);
  const base = await seedBase(c);
  await setProductStatus(c, base.product, "PUBLISHED", "launch product");
  const b = await createVariant(c, base.product, { sku: uniq("B"), name: "B", fulfillmentMethod: "MANUAL", price: 1_000_000 });
  await setVariantStatus(c, base.variant, "PUBLISHED", "launch variant");
  await setVariantStatus(c, b.id, "PUBLISHED", "launch variant");
  ids = { a: base.variant, b: b.id };
});
afterAll(async () => {
  await f?.app.close();
  await f?.t.drop();
});

describe("quote consistency under concurrent price changes", () => {
  it("a price change waits for an in-flight quote transaction (FOR SHARE) and lands after it", async () => {
    const c = adminCtx(f);
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    let changed = false;
    let q1!: number;
    const quoting = withTransaction(f.app.db, async (tx) => {
      q1 = (await quote(tx, [{ variantId: ids.a, quantity: 1 }], new Date())).subtotal;
      await hold; // the quote's transaction stays open
      return (await quote(tx, [{ variantId: ids.a, quantity: 1 }], new Date())).subtotal;
    });
    await new Promise((r) => setTimeout(r, 150));
    const updating = changePrice(c, ids.a, { price: 3_000_000, reason: "concurrent change" }).then(() => (changed = true));
    await new Promise((r) => setTimeout(r, 300));
    expect(changed).toBe(false); // blocked by the share lock
    release();
    const q2 = await quoting;
    await updating;
    expect(q1).toBe(q2); // one price generation inside the transaction
    expect((await quote(f.app.db, [{ variantId: ids.a, quantity: 1 }], new Date())).subtotal).toBe(3_000_000);
  });

  it("two variants repriced together are never quoted with mixed generations (60 racing quotes)", async () => {
    const c = adminCtx(f);
    await withTransactionPair(c, 1_000_000); // start from one generation
    let stop = false;
    const updater = (async () => {
      for (let i = 1; !stop && i < 40; i++) {
        const price = 1_000_000 + i * 10;
        await withTransactionPair(c, price);
      }
    })();
    const seen = new Set<number>();
    try {
    for (let r = 0; r < 60; r++) {
      const q = await quote(f.app.db, [{ variantId: ids.a, quantity: 1 }, { variantId: ids.b, quantity: 1 }], new Date());
      expect(q.lines[0]!.unitPrice).toBe(q.lines[1]!.unitPrice);
      seen.add(q.lines[0]!.unitPrice);
    }
    } finally { stop = true; }
    await updater;
    expect(seen.size).toBeGreaterThanOrEqual(1);
  });
});

/** Reprice both variants in ONE transaction (the quote must see both or neither). */
async function withTransactionPair(c: ReturnType<typeof adminCtx>, price: number): Promise<void> {
  const { sql } = await import("drizzle-orm");
  await withTransaction(f.app.db, async (tx) => {
    await tx.execute(sql`select set_config('app.actor_id', 'racer', true)`);
    await tx.execute(sql`select 1 from product_variants where id in (${ids.a}::uuid, ${ids.b}::uuid) order by id for update`); // writers lock in id order, like quote's readers
    await tx.execute(sql`update product_variants set price = ${price}, sale_price = null, updated_at = now() where id in (${ids.a}::uuid, ${ids.b}::uuid)`);
  });
  void c;
}
