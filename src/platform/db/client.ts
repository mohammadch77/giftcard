import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { getLogger } from "../logging";
import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema>;
/** Transaction handle passed into use cases so they join the caller's unit of work. */
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface DatabaseHandle {
  readonly db: Database;
  readonly pool: Pool;
  close(): Promise<void>;
}

export function createDatabase(connectionString: string, poolMax = 10): DatabaseHandle {
  const pool = new Pool({ connectionString, max: poolMax });
  // An error on an IDLE pooled client (e.g. server restart, admin termination) is emitted on the
  // pool; without a listener Node would crash the process. Log a non-sensitive classification only.
  pool.on("error", (error: Error & { code?: string }) => {
    getLogger().error("db idle client error", { code: error.code ?? error.name });
  });
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}

/**
 * Run `fn` in one database transaction (READ COMMITTED). Correctness relies on row locks,
 * unique constraints and conditional updates — not on SERIALIZABLE retries.
 * Never perform external calls (gateway, supplier, SMS) inside `fn`.
 */
export function withTransaction<T>(db: Database, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(fn);
}
