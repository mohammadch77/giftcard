import type { Env } from "../config";
import { DomainError } from "../errors";
import type { SupplierAdapter, SupplierAdapterRegistry } from "../supplier-adapter";
import { TestSupplier } from "../supplier-adapter/testing/test-supplier";

type SupplierEnv = Pick<Env, "NODE_ENV" | "SUPPLIER_ADAPTERS">;

/**
 * GUARDED FACTORY. 'none' => EMPTY registry: every supplier operation fails closed (SUPPLIER_ADAPTER_NOT_CONFIGURED).
 * The scripted test supplier is refused in production even if env validation is bypassed. No real adapter exists (X3).
 */
export function createSupplierAdapters(env: SupplierEnv): SupplierAdapterRegistry {
  const map = new Map<string, SupplierAdapter>();
  if (env.SUPPLIER_ADAPTERS === "test") {
    if (env.NODE_ENV === "production") throw new DomainError("SUPPLIER_ADAPTER_FORBIDDEN", "the test supplier adapter is forbidden in production");
    map.set("test", new TestSupplier());
  }
  return map;
}
