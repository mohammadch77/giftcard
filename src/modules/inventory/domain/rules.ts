import { z } from "zod";
import { DomainError } from "@/platform/errors";

export type CodeStatus = "AVAILABLE" | "RESERVED" | "SOLD" | "VOID" | "QUARANTINED" | "EXPIRED";
export type ReservationStatus = "ACTIVE" | "CONSUMED" | "RELEASED" | "EXPIRED";
export type PayloadKind = "CODE" | "ACCOUNT";

/**
 * Reservation TTL: B3 is OPEN; 15 minutes is a TECHNICAL DEFAULT supplied by the caller (orders will pass the
 * configured value). It is never extended (D9). Bounds protect against accidental extremes.
 */
export const DEFAULT_RESERVATION_TTL_SECONDS = 900;
export const MIN_RESERVATION_TTL_SECONDS = 60;
export const MAX_RESERVATION_TTL_SECONDS = 3600;
export const MAX_LINES = 50;
export const MAX_LINE_QUANTITY = 1000;
export const MAX_IMPORT_CODES = 5000;
export const MAX_SECRET_LENGTH = 4096;

/** Admin-changeable code states (everything else is driven by reservations). */
export const ADMIN_CODE_TRANSITIONS: Readonly<Record<string, readonly CodeStatus[]>> = {
  AVAILABLE: ["VOID", "QUARANTINED"],
  QUARANTINED: ["AVAILABLE", "VOID"],
};

const uuid = z.string().uuid();
export const reserveInput = z.strictObject({
  reservationKey: z.string().min(1).max(200),
  orderRef: z.string().min(1).max(200),
  ttlSeconds: z.number().int().min(MIN_RESERVATION_TTL_SECONDS).max(MAX_RESERVATION_TTL_SECONDS).optional(),
  lines: z.array(z.strictObject({ variantId: uuid, quantity: z.number().int().min(1).max(MAX_LINE_QUANTITY) })).min(1).max(MAX_LINES),
});
export type ReserveInput = z.infer<typeof reserveInput>;

/** OPS-2: an expiry is OPTIONAL everywhere (not every supplier provides one). A code may carry its own; otherwise the batch expiry applies. */
export const importItem = z.union([z.string(), z.strictObject({ code: z.string(), expiresAt: z.date().nullable().optional() })]);
export const importInput = z.strictObject({
  payloadKind: z.enum(["CODE", "ACCOUNT"]),
  codes: z.array(importItem).min(1).max(MAX_IMPORT_CODES),
  note: z.string().max(500).optional(),
  expiresAt: z.date().nullable().optional(),
});

export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  // Messages carry paths/reasons only, never values (codes must not leak into errors).
  if (!r.success) throw new DomainError("INVENTORY_INVALID", `invalid input: ${r.error.issues.map((i) => `${i.path.map((p) => (typeof p === "number" ? "#" : p)).join(".")}: ${i.code}`).join("; ")}`);
  return r.data;
}
