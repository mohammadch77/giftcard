import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { createDatabase } from "../../src/platform/db/client";
import type { DatabaseHandle } from "../../src/platform/db/client";
import { runMigrations } from "../../src/platform/db/migrate";

export interface TestDatabase extends DatabaseHandle {
  readonly url: string;
  drop(): Promise<void>;
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

  return {
    ...handle,
    url,
    async drop() {
      await handle.close();
      const c = new Client({ connectionString: admin });
      await c.connect();
      try {
        await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await c.end();
      }
    },
  };
}
