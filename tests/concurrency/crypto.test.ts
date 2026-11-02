import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DevKeyProvider } from "@/platform/crypto/testing/dev-key-provider";
import { createTestDatabase, pgCode } from "../helpers/db";
import type { TestDatabase } from "../helpers/db";
import { PROBE_DDL, readSecret, rewrapRow, storeSecret } from "../helpers/secret-store";

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
  await t.pool.query(PROBE_DDL);
});
afterAll(async () => {
  await t?.drop();
});

describe("crypto under concurrency", () => {
  it("300 concurrent store+read operations all return exactly their own secret", async () => {
    const p = DevKeyProvider.generate(1);
    const results = await Promise.all(
      Array.from({ length: 300 }, async (_, i) => {
        const id = await storeSecret(t.pool, p, `CONC-SECRET-${i}-QWER`);
        return { i, got: await readSecret(t.pool, p, id) };
      }),
    );
    for (const r of results) expect(r.got).toBe(`CONC-SECRET-${r.i}-QWER`);
  });

  it("50 concurrent imports of the SAME code (in different spellings) leave exactly one row", async () => {
    await t.pool.query("truncate secret_probe");
    const p = DevKeyProvider.generate(1);
    const spellings = ["RACE-CODE-0001-ZZZZ", " RACE-CODE-0001-ZZZZ", "RACE-CODE-0001-ZZZZ  ", "RACE-CODE-\u200B0001-ZZZZ", "RACE-CODE-۰۰۰۱-ZZZZ"];
    const outcomes = await Promise.allSettled(Array.from({ length: 50 }, (_, i) => storeSecret(t.pool, p, spellings[i % spellings.length] as string)));
    const ok = outcomes.filter((o) => o.status === "fulfilled").length;
    const dup = outcomes.filter((o) => o.status === "rejected" && pgCode(o.reason) === "23505").length;
    expect(ok).toBe(1);
    expect(dup).toBe(49);
    expect((await t.pool.query("select count(*)::int n from secret_probe")).rows[0].n).toBe(1);
  });

  it("two workers re-wrapping the same 200 rows at the same time: every row ends on the new KEK and decrypts", async () => {
    await t.pool.query("truncate secret_probe");
    const v1 = DevKeyProvider.generate(1);
    const ids: string[] = [];
    for (let i = 0; i < 200; i++) ids.push(await storeSecret(t.pool, v1, `DUAL-REWRAP-${i}-ABC`));
    const v2 = v1.withRotation({ newKek: true });
    const run = () => Promise.all(ids.map((id) => rewrapRow(t.pool, v2, id)));
    const [a, b] = await Promise.all([run(), run()]);
    // each row was changed by exactly one of the two workers
    for (let i = 0; i < ids.length; i++) expect(Number(a[i]) + Number(b[i])).toBe(1);
    expect((await t.pool.query("select count(*)::int n from secret_probe where kek_version=2")).rows[0].n).toBe(200);
    const v2Only = v2.derive({ dropKek: [1] });
    for (const id of ids) expect(await readSecret(t.pool, v2Only, id)).toMatch(/^DUAL-REWRAP-/);
  });
});
