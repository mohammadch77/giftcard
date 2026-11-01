import { randomBytes } from "node:crypto";
import { loadEnv } from "@/platform/config";
import { createDatabase } from "@/platform/db";
import { runOutboxOnce } from "@/platform/outbox";
import type { OutboxRegistry } from "@/platform/outbox";

/**
 * Worker process. Phase 2b-1a: the outbox runner is wired, the handler registry is EMPTY
 * (no business events exist yet), so events — if any were enqueued — would be failed with
 * NO_HANDLER and eventually dead-lettered, never silently dropped.
 */
const registry: OutboxRegistry = new Map();

async function main(): Promise<void> {
  const env = loadEnv(); // throws on invalid configuration
  const handle = createDatabase(env.DATABASE_URL, 2);
  const workerId = `worker:${process.pid}:${randomBytes(4).toString("hex")}`;
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => (stopping = true));

  console.warn(`[worker] ${workerId} started (NODE_ENV=${env.NODE_ENV}); handlers registered: ${registry.size}`);
  try {
    while (!stopping) {
      const summary = await runOutboxOnce(handle.db, registry, { workerId, batchSize: env.OUTBOX_BATCH_SIZE });
      if (summary.claimed > 0) console.warn(`[worker] outbox ${JSON.stringify(summary)}`);
      await new Promise((resolve) => setTimeout(resolve, env.OUTBOX_POLL_INTERVAL_MS));
    }
  } finally {
    await handle.close();
    console.warn("[worker] stopped");
  }
}

/** Non-sensitive classification only (class name + SQLSTATE if any); never the message or query text. */
function classify(error: unknown): string {
  const e = error as { name?: string; code?: string; cause?: { code?: string } };
  return [e?.name ?? "error", e?.cause?.code ?? e?.code].filter(Boolean).join(":");
}

main().catch((error: unknown) => {
  console.error("[worker] fatal:", classify(error));
  process.exit(1);
});
