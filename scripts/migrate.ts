import { parseEnv } from "../src/platform/config/env";
import { runMigrations } from "../src/platform/db/migrate";

// Usage: npm run db:migrate   (reads .env if present). Forward-only; no rollback by design.
async function main(): Promise<void> {
  const env = parseEnv(process.env);
  await runMigrations(env.MIGRATION_DATABASE_URL ?? env.DATABASE_URL);
  console.log("migrations applied");
}

main().catch((error: unknown) => {
  console.error("migration failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
