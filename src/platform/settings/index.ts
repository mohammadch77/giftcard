import type { z } from "zod";
import { DomainError } from "@/platform/errors";

/**
 * ADM-1 shared MECHANICS (no storage, no business meaning). Each business module owns its typed settings, their tables and their
 * bounds; this file only holds the pieces every module needs so they behave identically: server-side typed parsing and the mandatory
 * change reason. There is deliberately NO generic key/value store here — a setting that exists is a typed column of a module-owned,
 * append-only version table (see docs/ADMIN_SETTINGS_ARCHITECTURE.md).
 */
export const SETTINGS_REASON_MIN = 10;
export const SETTINGS_REASON_MAX = 500;

/** A setting version as read back from its owner's table. `version` is monotonically increasing per owner table. */
export interface SettingVersion<T> {
  version: number;
  values: T;
  /** SEED = the owner-approved initial value written by a migration; ADMIN = changed through the audited service. */
  source: "SEED" | "ADMIN";
}

/** Parse untrusted input against the owner's zod schema; any failure is SETTINGS_INVALID (never echoes secret-looking input). */
export function parseSetting<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new DomainError("SETTINGS_INVALID", `invalid setting: ${r.error.issues.map((i) => `${i.path.join(".") || "(value)"}: ${i.message}`).join("; ")}`);
  return r.data;
}

/** A change reason is mandatory (audit): trimmed, 10–500 characters. */
export function requireReason(reason: unknown): string {
  if (typeof reason !== "string") throw new DomainError("SETTINGS_INVALID", "a change reason is required");
  const r = reason.trim();
  if (r.length < SETTINGS_REASON_MIN || r.length > SETTINGS_REASON_MAX) throw new DomainError("SETTINGS_INVALID", `a change reason of ${SETTINGS_REASON_MIN}-${SETTINGS_REASON_MAX} characters is required`);
  return r;
}
