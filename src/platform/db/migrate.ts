import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDatabase } from "./client";

export const MIGRATIONS_FOLDER = path.resolve(process.cwd(), "db/migrations");

/** Apply all pending SQL migrations (forward-only) using a short-lived connection. */
export async function runMigrations(connectionString: string, folder: string = MIGRATIONS_FOLDER): Promise<void> {
  const handle = createDatabase(connectionString, 1);
  try {
    await migrate(handle.db, { migrationsFolder: folder });
  } finally {
    await handle.close();
  }
}
