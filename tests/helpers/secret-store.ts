import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { decodeSealed, encodeSealed, fingerprint, fingerprintsAllVersions, normalizeCode, openSecret, rewrapSecret, sealSecret } from "@/platform/crypto";
import type { KeyProvider } from "@/platform/crypto";

/**
 * TEST-ONLY reference of how a future module (inventory/suppliers/fulfillment) stores a secret with
 * the platform crypto primitives. It uses a probe table created by the test, never a business table.
 */
export const PROBE_DDL = `
  create table secret_probe (
    id uuid primary key,
    ciphertext bytea not null, wrapped_dek bytea not null, kek_version int not null,
    fp bytea not null, fp_version int not null);
  create unique index secret_probe_fp on secret_probe (fp);`;

const ctxFor = (id: string) => ({ table: "secret_probe", rowId: id, kind: "code" });

export async function storeSecret(pool: Pool, p: KeyProvider, rawCode: string): Promise<string> {
  const id = randomUUID();
  const normalized = normalizeCode(rawCode);
  const sealed = await sealSecret(p, normalized, ctxFor(id));
  const fp = await fingerprint(p, "code", normalized);
  await pool.query("insert into secret_probe values ($1,$2,$3,$4,$5,$6)", [id, sealed.ciphertext, sealed.wrappedDek, sealed.kekVersion, fp.digest, fp.hmacVersion]);
  return id;
}

export async function readSecret(pool: Pool, p: KeyProvider, id: string): Promise<string> {
  const r = await pool.query("select ciphertext, wrapped_dek, kek_version from secret_probe where id=$1", [id]);
  const row = r.rows[0] as { ciphertext: Buffer; wrapped_dek: Buffer; kek_version: number };
  const plain = await openSecret(p, { format: 1, kekVersion: row.kek_version, wrappedDek: row.wrapped_dek, ciphertext: row.ciphertext }, ctxFor(id));
  try {
    return plain.toString("utf8");
  } finally {
    plain.fill(0);
  }
}

/** Duplicate lookup under EVERY available pepper version (required so a pepper rotation hides nothing). */
export async function isDuplicate(pool: Pool, p: KeyProvider, rawCode: string): Promise<boolean> {
  const fps = await fingerprintsAllVersions(p, "code", normalizeCode(rawCode));
  const r = await pool.query("select 1 from secret_probe where fp = any($1::bytea[])", [fps.map((f) => f.digest)]);
  return (r.rowCount ?? 0) > 0;
}

/** Optimistic re-wrap of one row: touches only wrapped_dek and kek_version. Returns true if THIS call changed it. */
export async function rewrapRow(pool: Pool, p: KeyProvider, id: string): Promise<boolean> {
  const r = await pool.query("select ciphertext, wrapped_dek, kek_version from secret_probe where id=$1", [id]);
  const row = r.rows[0] as { ciphertext: Buffer; wrapped_dek: Buffer; kek_version: number };
  const current = { format: 1 as const, kekVersion: row.kek_version, wrappedDek: row.wrapped_dek, ciphertext: row.ciphertext };
  const next = await rewrapSecret(p, current, ctxFor(id));
  if (next === current) return false;
  const u = await pool.query("update secret_probe set wrapped_dek=$2, kek_version=$3 where id=$1 and kek_version=$4", [id, next.wrappedDek, next.kekVersion, row.kek_version]);
  return u.rowCount === 1;
}

export { decodeSealed, encodeSealed };
