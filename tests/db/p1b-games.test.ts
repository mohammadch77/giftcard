import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  archiveGameOrPlatform, createGame, createPlatform, createProduct, createRegion, createVariant, getProductAdmin, getVariantSnapshot, linkGamePlatform, linkGamePlatformRegion,
  listPublished, setGameAccountAttributes, setProductStatus, setVariantStatus, updateProduct, updateVariant,
} from "@/modules/catalog";
import type { AdminContext } from "@/modules/catalog";
import { claimManualTask, completeManualTask, createTasks } from "@/modules/fulfillment";
import type { FulfillmentAdminContext } from "@/modules/fulfillment";
import { adjustStock } from "@/modules/inventory";
import { withTransaction } from "@/platform/db";
import { pgCode } from "../helpers/db";
import { adminCtx, uniq } from "../helpers/catalog";
import { invCtx } from "../helpers/inventory";
import { gatewayCheckout, orderFixture, userId } from "../helpers/orders";
import type { OrderFixture } from "../helpers/orders";
import { seedPaidOrder } from "../helpers/suppliers";

let f: OrderFixture;
beforeAll(async () => { f = await orderFixture(); });
afterAll(async () => { await f?.app.close(); await f?.t.drop(); });

const ctx = (allowed: "all" | string[] = "all", actorId = "admin-1"): AdminContext => adminCtx(f, allowed, actorId);
const err = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as { code?: string }).code ?? "OTHER"; } return "NO_ERROR"; };
const sqlCode = (q: string, p: unknown[] = []) => f.t.pool.query(q, p).then(() => "ok", (e: unknown) => pgCode(e));
const appSqlCode = (q: string, p: unknown[] = []) => f.app.pool.query(q, p).then(() => "ok", (e: unknown) => pgCode(e));
const region = async () => (await createRegion(ctx(), { code: Array.from({ length: 6 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join(""), name: "R" })).id;

/** A game on one platform in one region, ready for game-account products. */
async function world() {
  const game = (await createGame(ctx(), { slug: uniq("game"), name: "Game" })).id;
  const platform = (await createPlatform(ctx(), { slug: uniq("plat"), name: "Platform" })).id;
  const otherPlatform = (await createPlatform(ctx(), { slug: uniq("plat"), name: "Other platform" })).id;
  const r = await region();
  const otherRegion = await region();
  await linkGamePlatform(ctx(), { gameId: game, platformId: platform });
  await linkGamePlatformRegion(ctx(), { gameId: game, platformId: platform, regionId: r });
  return { game, platform, otherPlatform, region: r, otherRegion };
}
const accountProduct = (gameId?: string) => createProduct(ctx(), { type: "GAME_ACCOUNT", brandId: f.base.brand, categoryId: f.base.category, ...(gameId ? { gameId } : {}), slug: uniq("acct"), name: "Account" });
const ATTRS = { accountType: "FULL_ACCESS", level: 42, includedItems: ["Season pass", "10 skins"], features: ["Region free"] };

describe("B1: games and platforms are first-class, with relationships", () => {
  it("are created by name/slug with validation, unique slugs, the manage permission, and an audit trail", async () => {
    const slug = uniq("g");
    const g = await createGame(ctx(), { slug, name: "Elden Ring" });
    expect((await f.t.pool.query("select slug, name, status from games where id = $1", [g.id])).rows[0]).toEqual({ slug, name: "Elden Ring", status: "ACTIVE" });
    expect(await err(createGame(ctx(), { slug, name: "Again" }))).toBe("CATALOG_CONFLICT");
    expect(await err(createGame(ctx(), { slug: "Bad Slug", name: "x" }))).toBe("CATALOG_INVALID");
    expect(await err(createGame(ctx(), { slug: uniq("g"), name: "" }))).toBe("CATALOG_INVALID");
    expect(await err(createGame(ctx(), { slug: uniq("g"), name: "x", extra: 1 } as never))).toBe("CATALOG_INVALID");
    expect(await err(createGame(ctx([]), { slug: uniq("g"), name: "x" }))).toBe("AUTH_FORBIDDEN");
    expect(await err(createPlatform(ctx([]), { slug: uniq("p"), name: "x" }))).toBe("AUTH_FORBIDDEN");
    const p = await createPlatform(ctx(), { slug: uniq("p"), name: "PlayStation 5" });
    expect(await err(createPlatform(ctx(), { slug: "!!", name: "x" }))).toBe("CATALOG_INVALID");
    for (const [action, id] of [["catalog.game.created", g.id], ["catalog.platform.created", p.id]] as const) {
      expect((await f.t.pool.query("select actor_id from audit_logs where action = $1 and entity_id = $2", [action, id])).rows).toEqual([{ actor_id: "admin-1" }]);
    }
    // rows are archived, never deleted, and identity columns are frozen
    expect(await appSqlCode("delete from games")).toBe("42501");
    expect(await sqlCode("update games set slug = 'zzz' where id = $1", [g.id])).toBe("PI001");
  });

  it("relationships: game↔platform, game↔platform↔region; idempotent, validated, append-only", async () => {
    const w = await world();
    expect(await linkGamePlatform(ctx(), { gameId: w.game, platformId: w.platform })).toEqual({ created: false }); // idempotent
    expect(await linkGamePlatform(ctx(), { gameId: w.game, platformId: w.otherPlatform })).toEqual({ created: true });
    expect(await err(linkGamePlatform(ctx(), { gameId: w.game, platformId: "0192a000-0000-7000-8000-0000000000ff" }))).toBe("CATALOG_INVALID");
    expect(await err(linkGamePlatform(ctx([]), { gameId: w.game, platformId: w.platform }))).toBe("AUTH_FORBIDDEN");
    // a region needs an existing game↔platform link
    const third = (await createPlatform(ctx(), { slug: uniq("plat"), name: "Third" })).id;
    expect(await err(linkGamePlatformRegion(ctx(), { gameId: w.game, platformId: third, regionId: w.region }))).toBe("CATALOG_INVALID");
    expect(await linkGamePlatformRegion(ctx(), { gameId: w.game, platformId: w.platform, regionId: w.region })).toEqual({ created: false });
    expect(await linkGamePlatformRegion(ctx(), { gameId: w.game, platformId: w.platform, regionId: w.otherRegion })).toEqual({ created: true });
    // an archived platform cannot be linked; relationships can never be removed or changed
    const gone = (await createPlatform(ctx(), { slug: uniq("plat"), name: "Gone" })).id;
    await archiveGameOrPlatform(ctx(), "platform", gone, "retired platform");
    expect(await err(linkGamePlatform(ctx(), { gameId: w.game, platformId: gone }))).toBe("CATALOG_INVALID");
    expect(await appSqlCode("delete from game_platforms")).toBe("42501");
    expect(await sqlCode("delete from game_platforms")).not.toBe("ok");
    expect(await sqlCode("delete from game_platform_regions")).not.toBe("ok");
    expect(await sqlCode("update game_platform_regions set created_at = now()")).not.toBe("ok");
  });

  it("archiving needs a reason and is refused while published data uses the game or platform", async () => {
    const w = await world();
    const p = await accountProduct(w.game);
    const v = await createVariant(ctx(), p.id, { sku: uniq("A"), name: "A", fulfillmentMethod: "MANUAL", platformId: w.platform, regionId: w.region, price: 1_000_000 });
    await setGameAccountAttributes(ctx(), v.id, ATTRS);
    await setProductStatus(ctx(), p.id, "PUBLISHED", "launch product");
    await setVariantStatus(ctx(), v.id, "PUBLISHED", "launch variant");
    expect(await err(archiveGameOrPlatform(ctx(), "game", w.game, "x"))).toBe("CATALOG_INVALID");
    expect(await err(archiveGameOrPlatform(ctx(), "game", w.game, "retiring the game"))).toBe("CATALOG_INVALID");
    expect(await err(archiveGameOrPlatform(ctx(), "platform", w.platform, "retiring the platform"))).toBe("CATALOG_INVALID");
    expect(await err(archiveGameOrPlatform(ctx(["catalog.products.manage"]), "platform", w.otherPlatform, "no publish permission"))).toBe("AUTH_FORBIDDEN");
    await archiveGameOrPlatform(ctx(), "platform", w.otherPlatform, "unused platform retired");
    expect((await f.t.pool.query("select status from platforms where id = $1", [w.otherPlatform])).rows[0].status).toBe("ARCHIVED");
    expect(await err(archiveGameOrPlatform(ctx(), "platform", w.otherPlatform, "already archived"))).toBe("CATALOG_NOT_FOUND");
  });

  it("a variant's platform must belong to its product's game, and platform + region must be a combination the game is offered in (service and database)", async () => {
    const w = await world();
    const p = await accountProduct(w.game);
    const mk = (extra: Record<string, unknown>) => createVariant(ctx(), p.id, { sku: uniq("V"), name: "V", fulfillmentMethod: "MANUAL", price: 1000, ...extra });
    expect(await err(mk({ platformId: w.platform, regionId: w.region }))).toBe("NO_ERROR");
    expect(await err(mk({ platformId: w.platform }))).toBe("NO_ERROR"); // region optional
    expect(await err(mk({ platformId: w.otherPlatform }))).toBe("CATALOG_INVALID"); // game not offered on that platform
    expect(await err(mk({ platformId: w.platform, regionId: w.otherRegion }))).toBe("CATALOG_INVALID"); // not offered in that region
    const raw = await sqlCode(`insert into product_variants (id, product_id, sku, name, platform_id, fulfillment_method, price, created_at, updated_at) values (gen_random_uuid(), $1, $2, 'raw', $3, 'MANUAL', 100, now(), now())`, [p.id, uniq("R"), w.otherPlatform]);
    expect(raw).toBe("PC005");
    // updating the region/platform of an existing variant is checked too
    const v = await mk({ platformId: w.platform, regionId: w.region });
    expect(await err(updateVariant(ctx(), v.id, { regionId: w.otherRegion }))).toBe("CATALOG_INVALID");
    expect(await err(updateVariant(ctx(), v.id, { platformId: w.otherPlatform }))).toBe("CATALOG_INVALID");
    await linkGamePlatform(ctx(), { gameId: w.game, platformId: w.otherPlatform });
    expect(await err(updateVariant(ctx(), v.id, { platformId: w.otherPlatform, regionId: null }))).toBe("NO_ERROR");
    // a product without a game accepts any active platform (e.g. a store gift card)
    const gift = await createProduct(ctx(), { type: "GIFT_CARD", brandId: f.base.brand, categoryId: f.base.category, slug: uniq("gc"), name: "Gift" });
    expect(await err(createVariant(ctx(), gift.id, { sku: uniq("G"), name: "G", fulfillmentMethod: "AUTO_CODE", platformId: w.otherPlatform, price: 1000 }))).toBe("NO_ERROR");
  });

  it("the game and platform of an existing variant are chosen while DRAFT only; an archived game cannot be assigned; changing the game re-checks the variants", async () => {
    const w = await world();
    const other = (await createGame(ctx(), { slug: uniq("game"), name: "Other game" })).id;
    const p = await accountProduct(w.game);
    const v = await createVariant(ctx(), p.id, { sku: uniq("V"), name: "V", fulfillmentMethod: "MANUAL", platformId: w.platform, price: 1000 });
    expect(await err(updateProduct(ctx(), p.id, { gameId: other }))).toBe("CATALOG_INVALID"); // variant platform is not offered for the other game
    await linkGamePlatform(ctx(), { gameId: other, platformId: w.platform });
    expect(await err(updateProduct(ctx(), p.id, { gameId: other }))).toBe("NO_ERROR");
    const retired = (await createGame(ctx(), { slug: uniq("game"), name: "Retired" })).id;
    await archiveGameOrPlatform(ctx(), "game", retired, "retired game");
    expect(await err(updateProduct(ctx(), p.id, { gameId: retired }))).toBe("CATALOG_INVALID");
    expect(await err(accountProduct(retired))).toBe("CATALOG_INVALID");
    await setGameAccountAttributes(ctx(), v.id, ATTRS);
    await setProductStatus(ctx(), p.id, "PUBLISHED", "launch product");
    await setVariantStatus(ctx(), v.id, "PUBLISHED", "launch variant");
    expect(await err(updateProduct(ctx(), p.id, { gameId: w.game }))).toBe("CATALOG_INVALID"); // product is PUBLISHED
    expect(await err(updateVariant(ctx(), v.id, { platformId: null }))).toBe("CATALOG_INVALID"); // variant is PUBLISHED
  });
});

describe("B2: game-account products are a distinct type with typed attributes", () => {
  it("publication needs the game (product) and the platform + attributes (variant); gift cards and other types are unaffected", async () => {
    const w = await world();
    const noGame = await accountProduct();
    expect(await err(setProductStatus(ctx(), noGame.id, "PUBLISHED", "launch without a game"))).toBe("CATALOG_INVALID");
    const p = await accountProduct(w.game);
    await setProductStatus(ctx(), p.id, "PUBLISHED", "launch product");
    const bare = await createVariant(ctx(), p.id, { sku: uniq("V"), name: "V", fulfillmentMethod: "MANUAL", price: 1000 });
    expect(await err(setVariantStatus(ctx(), bare.id, "PUBLISHED", "no platform, no attributes"))).toBe("CATALOG_INVALID");
    await updateVariant(ctx(), bare.id, { platformId: w.platform });
    expect(await err(setVariantStatus(ctx(), bare.id, "PUBLISHED", "no attributes yet"))).toBe("CATALOG_INVALID");
    await setGameAccountAttributes(ctx(), bare.id, ATTRS);
    expect(await err(setVariantStatus(ctx(), bare.id, "PUBLISHED", "complete now"))).toBe("NO_ERROR");
    // another product type is not subject to these requirements
    const dv = await createProduct(ctx(), { type: "DIGITAL_SERVICE", brandId: f.base.brand, categoryId: f.base.category, slug: uniq("svc"), name: "Svc" });
    await setProductStatus(ctx(), dv.id, "PUBLISHED", "launch product");
    const sv = await createVariant(ctx(), dv.id, { sku: uniq("S"), name: "S", fulfillmentMethod: "MANUAL", price: 1000 });
    expect(await err(setVariantStatus(ctx(), sv.id, "PUBLISHED", "plain service"))).toBe("NO_ERROR");
  });

  it("attributes are typed and validated: account type code, level range, bounded lists; unknown fields (e.g. a password) are not representable", async () => {
    const w = await world();
    const p = await accountProduct(w.game);
    const v = await createVariant(ctx(), p.id, { sku: uniq("V"), name: "V", fulfillmentMethod: "MANUAL", platformId: w.platform, price: 1000 });
    const set = (a: unknown) => err(setGameAccountAttributes(ctx(), v.id, a));
    expect(await set({ accountType: "FULL_ACCESS" })).toBe("NO_ERROR");
    expect(await set(ATTRS)).toBe("NO_ERROR");
    for (const bad of [
      { accountType: "lower_case" }, { accountType: "X" }, { accountType: "A".repeat(31) }, { accountType: "OK", level: -1 }, { accountType: "OK", level: 100_001 }, { accountType: "OK", level: 1.5 },
      { accountType: "OK", includedItems: Array.from({ length: 51 }, (_, i) => `i${i}`) }, { accountType: "OK", features: Array.from({ length: 31 }, (_, i) => `f${i}`) },
      { accountType: "OK", includedItems: [""] }, { accountType: "OK", includedItems: ["x".repeat(121)] }, { accountType: "OK", includedItems: [5] },
      { accountType: "OK", password: "hunter2" }, { accountType: "OK", credentials: { login: "a", pass: "b" } }, { accountType: "OK", email: "a@b.c" }, {}, null,
    ]) expect(await set(bad), JSON.stringify(bad)).toBe("CATALOG_INVALID");
    expect(await set({ accountType: "OK", level: null, includedItems: [], features: [] })).toBe("NO_ERROR");
    const row = (await f.t.pool.query("select account_type, level, included_items, features from game_account_attributes where variant_id = $1", [v.id])).rows[0];
    expect(row).toEqual({ account_type: "OK", level: null, included_items: [], features: [] });
    expect(await err(setGameAccountAttributes(ctx([]), v.id, ATTRS))).toBe("AUTH_FORBIDDEN");
    expect(await err(setGameAccountAttributes(ctx(), "0192a000-0000-7000-8000-0000000000ff", ATTRS))).toBe("CATALOG_NOT_FOUND");
    // the database enforces the same bounds
    expect(await sqlCode("update game_account_attributes set level = 999999 where variant_id = $1", [v.id])).toBe("23514");
    expect(await sqlCode("update game_account_attributes set account_type = 'bad' where variant_id = $1", [v.id])).toBe("23514");
    expect(await sqlCode("update game_account_attributes set included_items = '{\"a\":1}'::jsonb where variant_id = $1", [v.id])).toBe("23514");
  });

  it("attributes belong to GAME_ACCOUNT variants only and are editable only while the variant is DRAFT", async () => {
    const w = await world();
    const gift = await createProduct(ctx(), { type: "GIFT_CARD", brandId: f.base.brand, categoryId: f.base.category, slug: uniq("gc"), name: "Gift" });
    const gv = await createVariant(ctx(), gift.id, { sku: uniq("G"), name: "G", fulfillmentMethod: "AUTO_CODE", price: 1000 });
    expect(await err(setGameAccountAttributes(ctx(), gv.id, ATTRS))).toBe("CATALOG_INVALID");
    expect(await sqlCode(`insert into game_account_attributes (variant_id, account_type, created_at, updated_at) values ($1, 'X1', now(), now())`, [gv.id])).toBe("PC003");

    const p = await accountProduct(w.game);
    const v = await createVariant(ctx(), p.id, { sku: uniq("V"), name: "V", fulfillmentMethod: "MANUAL", platformId: w.platform, price: 1000 });
    await setGameAccountAttributes(ctx(), v.id, ATTRS);
    await setProductStatus(ctx(), p.id, "PUBLISHED", "launch product");
    await setVariantStatus(ctx(), v.id, "PUBLISHED", "launch variant");
    expect(await err(setGameAccountAttributes(ctx(), v.id, { ...ATTRS, level: 99 }))).toBe("CATALOG_INVALID");
    expect(await sqlCode("update game_account_attributes set level = 99 where variant_id = $1", [v.id])).toBe("PC003");
    await setVariantStatus(ctx(), v.id, "DRAFT", "rework the offer");
    expect(await err(setGameAccountAttributes(ctx(), v.id, { ...ATTRS, level: 99 }))).toBe("NO_ERROR");
    expect(await sqlCode("update game_account_attributes set variant_id = gen_random_uuid() where variant_id = $1", [v.id])).not.toBe("ok");
    expect(await appSqlCode("delete from game_account_attributes")).toBe("42501");
  });

  it("public flat attrs refuse credential-like names (the catalog is public data)", async () => {
    const w = await world();
    const p = await accountProduct(w.game);
    const mk = (attrs: Record<string, unknown>) => err(createVariant(ctx(), p.id, { sku: uniq("V"), name: "V", fulfillmentMethod: "MANUAL", price: 1000, attrs } as never));
    expect(await mk({ edition: "deluxe", year: 2026, shipping_note: "digital", keyboard_layout: "us" })).toBe("NO_ERROR"); // harmless names are fine (token based, no "contains pin")
    for (const bad of [{ password: "x" }, { account_password: "x" }, { login_email: "a" }, { api_key: "k" }, { secret_note: "s" }, { auth_code: "1" }, { pin: "1234" }, { token: "t" }, { recovery_codes: "r" }, { cookie: "c" }]) {
      expect(await mk(bad), JSON.stringify(bad)).toBe("CATALOG_INVALID");
    }
    const v = await createVariant(ctx(), p.id, { sku: uniq("V"), name: "V", fulfillmentMethod: "MANUAL", price: 1000 });
    expect(await err(updateVariant(ctx(), v.id, { attrs: { password: "x" } }))).toBe("CATALOG_INVALID");
  });

  it("sensitive credentials never reach the catalog: no secret-like columns exist, and a delivered account credential appears in no catalog, audit or order data", async () => {
    const cols = (await f.t.pool.query(
      `select table_name, column_name from information_schema.columns where table_schema = 'public'
        and table_name in ('games','platforms','game_platforms','game_platform_regions','game_account_attributes','products','product_variants','variant_fulfillment_changes')`,
    )).rows as { table_name: string; column_name: string }[];
    for (const c of cols) expect(c.column_name, `${c.table_name}.${c.column_name}`).not.toMatch(/pass|secret|token|credential|login|sealed|otp|pin$/);
    expect(cols.filter((c) => c.table_name === "game_account_attributes").map((c) => c.column_name).sort()).toEqual(["account_type", "created_at", "features", "included_items", "level", "updated_at", "variant_id"]);

    // end to end: a game account is sold, a human fulfils it, the credential is sealed in the fulfilment secret path only
    const w = await world();
    const p = await accountProduct(w.game);
    const v = await createVariant(ctx(), p.id, { sku: uniq("V"), name: "V", fulfillmentMethod: "MANUAL", platformId: w.platform, regionId: w.region, price: 1_000_000 });
    await setGameAccountAttributes(ctx(), v.id, ATTRS);
    await setProductStatus(ctx(), p.id, "PUBLISHED", "launch product");
    await setVariantStatus(ctx(), v.id, "PUBLISHED", "launch variant");
    await adjustStock(invCtx(f), v.id, 2, "opening manual stock");
    const user = userId();
    await gatewayCheckout(f, user, [{ variantId: v.id, quantity: 1 }]);
    const so = await seedPaidOrder(f, user, [{ variantId: v.id }]);
    await withTransaction(f.app.db, (tx) => createTasks(tx, f.clock, { orderRef: so.orderId, userRef: user, paymentRef: "pay-1", items: [{ orderItemRef: so.refs[0]!, variantId: v.id }] }));
    const taskId = (await f.t.pool.query("select id from fulfillment_tasks where order_item_ref = $1", [so.refs[0]])).rows[0].id as string;
    const fctx: FulfillmentAdminContext = { db: f.app.db, clock: f.clock, keys: f.keys, actor: { type: "ADMIN", id: "alice" }, authorize: async () => undefined };
    const CANARY = "ACCOUNT-LOGIN-CANARY: gamer@example.test / Pa55-CANARY-w0rd";
    await claimManualTask(fctx, taskId);
    await completeManualTask(fctx, taskId, CANARY);
    for (const table of ["games", "platforms", "game_platforms", "game_platform_regions", "game_account_attributes", "products", "product_variants", "variant_fulfillment_changes", "variant_price_history", "product_status_history", "variant_status_history", "audit_logs", "orders", "order_items", "outbox_events"]) {
      expect(JSON.stringify((await f.t.pool.query(`select * from ${table}`)).rows), table).not.toContain("CANARY");
    }
  });
});

describe("B1/B2: snapshots and public reads", () => {
  it("new orders snapshot the game, platform and typed attributes; later edits never rewrite an existing order's snapshot", async () => {
    const w = await world();
    const p = await accountProduct(w.game);
    const v = await createVariant(ctx(), p.id, { sku: uniq("V"), name: "V", fulfillmentMethod: "MANUAL", platformId: w.platform, regionId: w.region, price: 1_000_000 });
    await setGameAccountAttributes(ctx(), v.id, ATTRS);
    await setProductStatus(ctx(), p.id, "PUBLISHED", "launch product");
    await setVariantStatus(ctx(), v.id, "PUBLISHED", "launch variant");
    await adjustStock(invCtx(f), v.id, 5, "opening manual stock");

    const first = await gatewayCheckout(f, userId(), [{ variantId: v.id, quantity: 1 }]);
    const snap1 = (await f.t.pool.query("select snapshot from order_items where order_id = $1", [first.orderId])).rows[0].snapshot;
    expect(snap1).toMatchObject({
      productType: "GAME_ACCOUNT", fulfillmentMethod: "MANUAL",
      game: { name: "Game" }, platform: { name: "Platform" },
      accountAttributes: { accountType: "FULL_ACCESS", level: 42, includedItems: ["Season pass", "10 skins"], features: ["Region free"] },
    });

    // rework the offer: unpublish, change the attributes, republish
    await setVariantStatus(ctx(), v.id, "DRAFT", "rework the offer");
    await setGameAccountAttributes(ctx(), v.id, { ...ATTRS, level: 77, features: ["Region free", "Ranked ready"] });
    await setVariantStatus(ctx(), v.id, "PUBLISHED", "republish after rework");
    const second = await gatewayCheckout(f, userId(), [{ variantId: v.id, quantity: 1 }]);
    const snap2 = (await f.t.pool.query("select snapshot from order_items where order_id = $1", [second.orderId])).rows[0].snapshot;
    expect(snap2.accountAttributes).toMatchObject({ level: 77, features: ["Region free", "Ranked ready"] });
    // the earlier order is exactly as it was sold
    expect((await f.t.pool.query("select snapshot from order_items where order_id = $1", [first.orderId])).rows[0].snapshot).toEqual(snap1);
    expect(snap1.accountAttributes.level).toBe(42);
    expect((await f.t.pool.query("update order_items set snapshot = '{}'::jsonb where order_id = $1", [first.orderId]).then(() => "ok", (e: unknown) => pgCode(e)))).not.toBe("ok");
  });

  it("public reads expose game, platform and the public attributes — nothing else — and non-account variants carry nulls", async () => {
    const w = await world();
    const p = await accountProduct(w.game);
    const v = await createVariant(ctx(), p.id, { sku: uniq("V"), name: "V", fulfillmentMethod: "MANUAL", platformId: w.platform, price: 1_000_000 });
    await setGameAccountAttributes(ctx(), v.id, ATTRS);
    await setProductStatus(ctx(), p.id, "PUBLISHED", "launch product");
    await setVariantStatus(ctx(), v.id, "PUBLISHED", "launch variant");
    const snap = await getVariantSnapshot(f.app.db, v.id);
    expect(snap).toMatchObject({ productType: "GAME_ACCOUNT", game: { name: "Game" }, platform: { name: "Platform" }, accountAttributes: { accountType: "FULL_ACCESS", level: 42 } });
    const listed = (await listPublished(f.app.db, { type: "GAME_ACCOUNT", limit: 100 })).items.find((x) => x.variantId === v.id);
    expect(listed?.accountAttributes?.includedItems).toEqual(["Season pass", "10 skins"]);
    const gift = await createProduct(ctx(), { type: "GIFT_CARD", brandId: f.base.brand, categoryId: f.base.category, slug: uniq("gc"), name: "Gift" });
    const gv = await createVariant(ctx(), gift.id, { sku: uniq("G"), name: "G", fulfillmentMethod: "AUTO_CODE", price: 1000 });
    expect(await getVariantSnapshot(f.app.db, gv.id)).toMatchObject({ game: null, platform: null, accountAttributes: null });
    const admin = await getProductAdmin(ctx(), p.id);
    expect(admin.product).toMatchObject({ game_id: w.game });
    expect(JSON.stringify(admin)).not.toMatch(/password|secret|credential/i);
  });
});
