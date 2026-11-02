import { bootstrapFirstOwner } from "../src/modules/identity";
import { parseEnv } from "../src/platform/config/env";
import { createDatabase } from "../src/platform/db";
import { systemClock } from "../src/platform/clock";

/**
 * Operator-only creation of the FIRST owner. No password/secret exists or is printed: the owner logs in
 * with mobile OTP and enrols TOTP. Refuses to run once any active owner exists.
 *   npm run identity:bootstrap-owner -- --phone 09121234567
 */
async function main(): Promise<void> {
  const i = process.argv.indexOf("--phone");
  const phone = i > -1 ? process.argv[i + 1] : undefined;
  if (!phone) throw new Error("usage: npm run identity:bootstrap-owner -- --phone <09xxxxxxxxx>");
  const env = parseEnv(process.env);
  const handle = createDatabase(env.MIGRATION_DATABASE_URL ?? env.DATABASE_URL, 2);
  try {
    const { userId } = await bootstrapFirstOwner(handle.db, systemClock, phone);
    console.log(`first owner created: ${userId}`);
  } finally {
    await handle.close();
  }
}

main().catch((e: unknown) => {
  console.error("bootstrap failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
