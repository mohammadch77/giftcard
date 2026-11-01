// Platform-owned tables only. Each business module owns its tables in
// src/modules/<name>/infra/schema.ts (private to that module — see .dependency-cruiser.cjs).
export * from "./meta";
export * from "./transitions";
export * from "./idempotency";
export * from "./outbox";
export * from "./roles";
