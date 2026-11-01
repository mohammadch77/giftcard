import { loadEnv } from "@/platform/config";

/**
 * Worker process skeleton (outbox consumer, reservation sweeper, supplier sync/retry,
 * reconciliation). Phase 2a: the registry is empty — no jobs are implemented.
 */
async function main(): Promise<void> {
  const env = loadEnv(); // throws on invalid configuration
  console.warn(`[worker] started (NODE_ENV=${env.NODE_ENV}); no jobs registered`);

  await new Promise<void>((resolve) => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => resolve());
  });
  console.warn("[worker] stopped");
}

main().catch((error: unknown) => {
  console.error("[worker] fatal:", error instanceof Error ? error.message : error);
  process.exit(1);
});
