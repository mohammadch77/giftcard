import { z } from "zod";
import { DomainError } from "@/platform/errors";
import { MAX_RIAL_AMOUNT } from "@/platform/money";
import type { SupplierProductInfo } from "@/platform/supplier-adapter";

export type SupplierOrderStatus = "CREATED" | "SUBMITTING" | "CONFIRMED" | "REJECTED" | "UNKNOWN";

/** Technical defaults (not business policy). */
export const DEFAULT_SUBMIT_TIMEOUT_MS = 30_000;
export const DEFAULT_SUBMIT_LEASE_SECONDS = 120;
export const MAX_SYNC_ITEMS = 5000;

const slug = /^[a-z][a-z0-9_-]{1,39}$/;
/** Config is non-secret, flat and bounded; hosts/URLs come from deployment configuration, never from data (SSRF), secrets never go here. */
const FORBIDDEN_CONFIG_KEY = /(secret|pass|token|key|credential|auth|url|uri|host|endpoint|address|domain)/i;
export const configSchema = z
  .record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), z.union([z.string().max(200), z.number().finite(), z.boolean()]))
  .refine((o) => Object.keys(o).length <= 20, "too many entries")
  .refine((o) => Object.keys(o).every((k) => !FORBIDDEN_CONFIG_KEY.test(k)), "config must not hold secrets, hosts or URLs");

export const supplierInput = z.strictObject({ key: z.string().regex(slug), name: z.string().trim().min(1).max(120), adapterKey: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/), config: configSchema.optional() });
export const supplierUpdate = z.strictObject({ name: z.string().trim().min(1).max(120).optional(), status: z.enum(["ACTIVE", "DISABLED"]).optional(), config: configSchema.optional() });
export const credentialsSchema = z.record(z.string().min(1).max(64), z.string().min(1).max(4096)).refine((o) => Object.keys(o).length >= 1 && Object.keys(o).length <= 10, "1..10 credential fields");
export const routeInput = z.strictObject({ variantId: z.string().uuid(), supplierProductId: z.string().uuid(), priority: z.number().int().min(1).max(20) });
export const orderInput = z.strictObject({
  supplierProductId: z.string().uuid(), orderItemRef: z.string().min(1).max(200), quantity: z.number().int().min(1).max(100), idempotencyKey: z.string().min(1).max(200),
});

export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  // paths and issue codes only — never values (credentials must not leak into errors)
  if (!r.success) throw new DomainError("SUPPLIER_INVALID", `invalid input: ${r.error.issues.map((i) => `${i.path.map((p) => (typeof p === "number" ? "#" : p)).join(".")}: ${i.code}`).join("; ")}`);
  return r.data;
}

const SKU = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;
export interface NormalizedProduct { externalSku: string; name: string; cost: number; available: boolean; stockHint: number | null }

/** Normalise one adapter item. Rejects (returns null) anything that is not integer-Rial IRR with a sane SKU/name — no FX or rounding is invented. */
export function normalizeProduct(p: SupplierProductInfo): NormalizedProduct | null {
  if (typeof p.externalSku !== "string" || !SKU.test(p.externalSku)) return null;
  if (typeof p.name !== "string" || p.name.trim().length < 1 || p.name.length > 200) return null;
  if (p.currency !== "IRR") return null;
  if (!Number.isSafeInteger(p.cost) || p.cost < 0 || p.cost > MAX_RIAL_AMOUNT) return null;
  if (typeof p.available !== "boolean") return null;
  const hint = p.stockHint;
  if (hint !== undefined && (!Number.isSafeInteger(hint) || hint < 0)) return null;
  return { externalSku: p.externalSku, name: p.name.trim(), cost: p.cost, available: p.available, stockHint: hint ?? null };
}

export interface SupplierPermissionDef { key: string; description: string; sensitive: boolean }
export const SUPPLIER_PERMISSIONS: readonly SupplierPermissionDef[] = [
  { key: "suppliers.read", description: "View suppliers, products, routes and supplier orders (never credentials or codes)", sensitive: false },
  { key: "suppliers.manage", description: "Create/update/disable suppliers", sensitive: false },
  { key: "suppliers.credentials.manage", description: "Set or rotate supplier credentials (write-only; cannot be read back)", sensitive: true },
  { key: "suppliers.routes.manage", description: "Map catalog variants to supplier products", sensitive: false },
  { key: "suppliers.sync.run", description: "Run a supplier price/availability synchronisation", sensitive: false },
  { key: "suppliers.orders.resolve", description: "Manually resolve an UNKNOWN supplier order", sensitive: true },
];
