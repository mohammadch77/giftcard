import { randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import type { PoolClient } from "pg";
import { createDatabase } from "../../src/platform/db/client";
import * as platformSchema from "../../src/platform/db/schema";
import type { DatabaseHandle } from "../../src/platform/db/client";
import { runMigrations } from "../../src/platform/db/migrate";

export interface TestDatabase extends DatabaseHandle {
  readonly url: string;
  /** Cluster-global roles created for this database; dropped after the database. */
  readonly roles: string[];
  drop(): Promise<void>;
}

export interface TestRoles {
  appRole: string;
  readonlyRole: string;
}

/** Postgres error code from a node-postgres or Drizzle-wrapped error. */
export function pgCode(error: unknown): string | undefined {
  const e = error as { code?: string; cause?: { code?: string } };
  return e?.code ?? e?.cause?.code;
}

/** Message of the underlying PostgreSQL error (Drizzle wraps it in a "Failed query" error). */
export function pgMessage(error: unknown): string {
  const e = error as { message?: string; cause?: { message?: string } };
  return `${e?.cause?.message ?? ""} ${e?.message ?? ""}`;
}

function adminUrl(): string {
  const url = process.env.TEST_DATABASE_ADMIN_URL;
  if (!url) {
    throw new Error(
      "TEST_DATABASE_ADMIN_URL is not set. DB tests need a PostgreSQL admin connection that can " +
        "CREATE/DROP throwaway databases (see .env.example). They are never skipped silently.",
    );
  }
  return url;
}

/** Replace the database name in a postgres URL (string-based: works for unix-socket URLs too). */
function withDatabase(url: string, name: string): string {
  const q = url.indexOf("?");
  const base = q === -1 ? url : url.slice(0, q);
  const query = q === -1 ? "" : url.slice(q);
  return `${base.replace(/\/[^/]*$/, `/${name}`)}${query}`;
}

/** Creates an isolated empty database, applies ALL production migrations, returns a handle. */
export async function createTestDatabase(options: { migrate?: boolean } = {}): Promise<TestDatabase> {
  const admin = adminUrl();
  const name = `giftcard_test_${randomBytes(6).toString("hex")}`;
  const client = new Client({ connectionString: admin });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE "${name}"`);
  } finally {
    await client.end();
  }
  const url = withDatabase(admin, name);
  if (options.migrate !== false) await runMigrations(url);
  const handle = createDatabase(url, 10);

  const roles: string[] = [];
  return {
    ...handle,
    url,
    roles,
    async drop() {
      await handle.close();
      const c = new Client({ connectionString: admin });
      await c.connect();
      try {
        await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
        for (const r of roles) await c.query(`DROP ROLE IF EXISTS "${r}"`);
      } finally {
        await c.end();
      }
    },
  };
}

/**
 * Creates unique NOLOGIN roles (roles are cluster-global), points platform_roles at them and
 * applies grants — the same steps db/ops/roles.sql performs in production.
 */
export async function createTestRoles(t: TestDatabase): Promise<TestRoles> {
  const suffix = randomBytes(5).toString("hex");
  const appRole = `gc_app_${suffix}`;
  const readonlyRole = `gc_ro_${suffix}`;
  t.roles.push(appRole, readonlyRole);
  await t.pool.query(`CREATE ROLE "${appRole}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`);
  await t.pool.query(`CREATE ROLE "${readonlyRole}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`);
  await t.pool.query("UPDATE platform_roles SET app_role = $1, readonly_role = $2", [appRole, readonlyRole]);
  await t.pool.query("SELECT platform_apply_grants()");
  return { appRole, readonlyRole };
}

/** Run `fn` on a connection that has switched to `role` (RESET afterwards). */
export async function asRole<T>(t: TestDatabase, role: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await t.pool.connect();
  try {
    await client.query(`SET ROLE "${role}"`);
    return await fn(client);
  } finally {
    await client.query("RESET ROLE").catch(() => undefined);
    client.release();
  }
}

/** A Drizzle handle whose every connection runs as `role` (e.g. the least-privilege application role). */
export function createDatabaseAsRole(t: TestDatabase, role: string, max = 10): DatabaseHandle {
  const pool = new Pool({ connectionString: t.url, options: `-c role=${role}`, max });
  pool.on("error", () => undefined);
  pool.on("connect", (client) => client.on("error", () => undefined));
  const db = drizzle(pool, { schema: platformSchema });
  return { db, pool, close: () => pool.end() };
}
