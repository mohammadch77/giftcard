import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fingerprint, normalizeCode } from "@/platform/crypto";
import { DevKeyProvider } from "@/platform/crypto/testing/dev-key-provider";
import { createTestDatabase, pgCode } from "../helpers/db";
import type { TestDatabase } from "../helpers/db";
import { PROBE_DDL, isDuplicate, readSecret, rewrapRow, storeSecret } from "../helpers/secret-store";

const CANARY = "STEAM-DBCANARY-7Q8W-9E0R-5T6Y";
let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
  await t.pool.query(PROBE_DDL);
});
afterAll(async () => {
  await t?.drop();
});

const tableDigest = async () =>
  createHash("sha256").update(JSON.stringify((await t.pool.query("select id, encode(ciphertext,'hex') c, encode(wrapped_dek,'hex') w, kek_version, encode(fp,'hex') f from secret_probe order by id")).rows)).digest("hex");

describe("encrypted storage in PostgreSQL", () => {
  it("round-trips, and neither the table content nor a full pg_dump of the database contains the plaintext", async () => {
    const p = DevKeyProvider.generate(1);
    const id = await storeSecret(t.pool, p, CANARY);
    expect(await readSecret(t.pool, p, id)).toBe(CANARY);

    const text = (await t.pool.query("select t::text as r from secret_probe t")).rows.map((r: { r: string }) => r.r).join("\n");
    expect(text).not.toContain("CANARY");
    expect(text.toLowerCase()).not.toContain(Buffer.from(CANARY).toString("hex"));

    const dump = execFileSync("pg_dump", ["--dbname", t.url, "--no-owner"], { maxBuffer: 64 * 1024 * 1024 }).toString("utf8");
    expect(dump).toContain("secret_probe");
    expect(dump).not.toContain(CANARY);
    expect(dump.toLowerCase()).not.toContain(Buffer.from(CANARY).toString("hex"));
  });

  it("the unique keyed fingerprint rejects duplicates, including differently written spellings", async () => {
    const p = DevKeyProvider.generate(1);
    await storeSecret(t.pool, p, "DUP-CODE-0001-AAAA");
    await expect(storeSecret(t.pool, p, " DUP-CODE-0001-AAAA ")).rejects.toSatisfy((e) => pgCode(e) === "23505");
    await expect(storeSecret(t.pool, p, "DUP-CODE-۰۰۰۱")).resolves.toBeTruthy(); // a different code
    expect(await isDuplicate(t.pool, p, "DUP-CODE-0001-AAAA")).toBe(true);
    expect(await isDuplicate(t.pool, p, "NEVER-STORED-XXXX")).toBe(false);
  });

  it("a ciphertext copied to another row (SQL swap attack) cannot be opened there", async () => {
    const p = DevKeyProvider.generate(1);
    const a = await storeSecret(t.pool, p, "SWAP-A-1111-2222");
    const b = await storeSecret(t.pool, p, "SWAP-B-3333-4444");
    await t.pool.query("update secret_probe set ciphertext=(select ciphertext from secret_probe where id=$1), wrapped_dek=(select wrapped_dek from secret_probe where id=$1) where id=$2", [a, b]);
    await expect(readSecret(t.pool, p, b)).rejects.toMatchObject({ code: "DECRYPT_FAILED" });
    expect(await readSecret(t.pool, p, a)).toBe("SWAP-A-1111-2222");
  });
});

describe("pepper rotation with stored fingerprints", () => {
  it("duplicates stay detectable through the rotation (all-versions lookup); a re-hash then makes the unique index protective again", async () => {
    const v1 = DevKeyProvider.generate(1);
    const raw = "ROT-PEPPER-9999-ZZZZ";
    const id = await storeSecret(t.pool, v1, raw);
    const v2 = v1.withRotation({ newPepper: true });

    expect(await isDuplicate(t.pool, v2, raw)).toBe(true); // found via the v1 fingerprint
    // Under v2 only, a naive insert would NOT collide (different digest) — this is why isDuplicate is mandatory:
    const naive = await fingerprint(v2, "code", normalizeCode(raw));
    expect((await t.pool.query("select 1 from secret_probe where fp=$1", [naive.digest])).rowCount).toBe(0);

    // maintenance: re-hash (decrypt -> new fingerprint)
    const plain = normalizeCode(await readSecret(t.pool, v2, id));
    const fresh = await fingerprint(v2, "code", plain);
    await t.pool.query("update secret_probe set fp=$2, fp_version=$3 where id=$1", [id, fresh.digest, fresh.hmacVersion]);
    await expect(storeSecret(t.pool, v2, raw)).rejects.toSatisfy((e) => pgCode(e) === "23505"); // now the index protects
  });
});

describe("KEK rotation and loss against stored rows", () => {
  it("rotates 500 rows with an interruption: every row stays readable throughout and v1 can be retired only when no row references it", async () => {
    await t.pool.query("truncate secret_probe");
    const v1 = DevKeyProvider.generate(1);
    const ids: string[] = [];
    for (let i = 0; i < 500; i++) ids.push(await storeSecret(t.pool, v1, `ROTATE-ROW-${i}-XYZ`));
    const v2 = v1.withRotation({ newKek: true });

    for (const id of ids.slice(0, 230)) await rewrapRow(t.pool, v2, id); // ...process killed here
    for (const id of ids) expect(await readSecret(t.pool, v2, id)).toMatch(/^ROTATE-ROW-/);
    const stillV1 = (await t.pool.query("select count(*)::int n from secret_probe where kek_version=1")).rows[0].n as number;
    expect(stillV1).toBe(270); // operator check: NOT safe to retire v1 yet

    for (const id of ids) await rewrapRow(t.pool, v2, id); // resume (idempotent for the 230 done)
    expect((await t.pool.query("select count(*)::int n from secret_probe where kek_version=1")).rows[0].n).toBe(0); // safe to retire
    const v2Only = v2.derive({ dropKek: [1] });
    for (const id of ids) expect(await readSecret(t.pool, v2Only, id)).toMatch(/^ROTATE-ROW-/);
    // payload ciphertext was never rewritten and nothing was deleted
    expect((await t.pool.query("select count(*)::int n from secret_probe")).rows[0].n).toBe(500);
  });

  it("KEK lost / wrong / back: reads fail closed, the stored data is untouched, and recovery restores access", async () => {
    await t.pool.query("truncate secret_probe");
    const good = DevKeyProvider.generate(1);
    const id = await storeSecret(t.pool, good, "LOSS-TEST-1234-ABCD");
    const before = await tableDigest();

    const lost = good.withRotation({ newKek: true }).derive({ dropKek: [1] });
    await expect(readSecret(t.pool, lost, id)).rejects.toMatchObject({ code: "KEY_VERSION_UNKNOWN" });
    await expect(readSecret(t.pool, good.withReplacedKek(1), id)).rejects.toMatchObject({ code: "DECRYPT_FAILED" });
    expect(await tableDigest()).toBe(before); // failed attempts changed nothing

    expect(await readSecret(t.pool, good, id)).toBe("LOSS-TEST-1234-ABCD"); // KEK restored from backup
  });
});
