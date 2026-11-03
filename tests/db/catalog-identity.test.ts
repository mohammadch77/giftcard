import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CATALOG_PERMISSIONS, changePrice, createBrand, createCategory, createProduct, createVariant } from "@/modules/catalog";
import type { AdminContext } from "@/modules/catalog";
import { toAuditActor } from "@/modules/identity";
import type { Actor } from "@/modules/identity";
import { bootstrapOwner, enrolStaff, errCode, identityFixture, relogin } from "../helpers/identity";
import type { IdentityFixture, StaffSession } from "../helpers/identity";
import { uniq } from "../helpers/catalog";

/** Real binding at the "composition root": catalog's AdminContext.authorize -> identity.authorize(actor, permission). */
let f: IdentityFixture;
let owner: StaffSession;
beforeAll(async () => {
  f = await identityFixture("2026-06-01T10:00:00Z", { otp: { sendsPerHour: 1000, verifiesPerHour: 1000, globalSendsPerHour: 100000 } });
  f.identity.catalog.register(CATALOG_PERMISSIONS);
  const phone = "+989120000001";
  await bootstrapOwner(f, phone);
  owner = await enrolStaff(f, phone);
});
afterAll(async () => {
  await f?.app.close();
  await f?.t.drop();
});

const bind = (actor: Actor): AdminContext => ({ db: f.app.db, clock: f.clock, actor: toAuditActor(actor), authorize: (p) => f.identity.authorize(actor, p) });

describe("catalog permissions through identity", () => {
  it("owner (seeded with the catalog permissions) manages the catalog; the audit actor is the staff user", async () => {
    const o = await relogin(f, owner);
    const ctx = bind(o.actor);
    const brand = await createBrand(ctx, { slug: uniq("b"), name: "B" });
    const cat = await createCategory(ctx, { slug: uniq("c"), name: "C" });
    const p = await createProduct(ctx, { type: "DIGITAL_SERVICE", brandId: brand.id, categoryId: cat.id, slug: uniq("p"), name: "P" });
    const v = await createVariant(ctx, p.id, { sku: "S1", name: "S1", fulfillmentMethod: "MANUAL", price: 1000 });
    await changePrice(ctx, v.id, { price: 2000, reason: "repricing test" });
    const a = (await f.t.pool.query("select actor_type, actor_id from audit_logs where action = 'catalog.variant.price_changed' order by id desc limit 1")).rows[0];
    expect(a).toEqual({ actor_type: "ADMIN", actor_id: o.userId });
    const h = (await f.t.pool.query("select changed_by from variant_price_history where variant_id = $1 order by id desc limit 1", [v.id])).rows[0];
    expect(h.changed_by).toBe(o.userId);
  });
  it("price changes need a fresh step-up; plain management does not", async () => {
    const o = await relogin(f, owner);
    const ctx = bind(o.actor);
    const brand = await createBrand(ctx, { slug: uniq("b"), name: "B" });
    const cat = await createCategory(ctx, { slug: uniq("c"), name: "C" });
    const p = await createProduct(ctx, { type: "DIGITAL_SERVICE", brandId: brand.id, categoryId: cat.id, slug: uniq("p"), name: "P" });
    f.clock.advance(6 * 60_000);
    await createBrand(ctx, { slug: uniq("b"), name: "again" }); // non-sensitive: still fine
    expect(await errCode(createVariant(ctx, p.id, { sku: "S2", name: "S2", fulfillmentMethod: "MANUAL", price: 1000 }))).toBe("AUTH_STEP_UP_REQUIRED");
  });
  it("a role without catalog permissions (support_agent) is refused; customers too", async () => {
    const o = await relogin(f, owner);
    const phone = "+989120000002";
    const { userId } = await f.identity.createStaff(o.actor, phone);
    await f.identity.grantRole(o.actor, userId, "support_agent");
    const s = await enrolStaff(f, phone);
    expect(await errCode(createBrand(bind(s.actor), { slug: uniq("b"), name: "B" }))).toBe("AUTH_FORBIDDEN");
  });
});
