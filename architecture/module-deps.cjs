/**
 * Allowed inter-module dependencies (single source of truth for dependency-cruiser and tests).
 * Key = importing module; value = modules it may import (through their index.ts only).
 * Everything not listed is forbidden. `ledger` and `audit` depend on no other module.
 * Cross-module reactions that would create a cycle (e.g. payments -> orders) go through
 * outbox events, never through imports. Changing this matrix requires an architecture review.
 */
module.exports = {
  audit: [],
  ledger: ["audit"], // every financial posting is audited (2b-2); audit itself depends on nothing
  identity: ["audit"],
  catalog: ["audit"],
  promotions: ["catalog", "audit"],
  pricing: ["catalog", "promotions"],
  inventory: ["catalog", "audit"],
  suppliers: ["catalog", "audit"],
  cart: ["catalog", "pricing"],
  payments: ["ledger", "audit"],
  wallet: ["ledger", "payments", "audit"],
  fulfillment: ["inventory", "suppliers", "ledger", "catalog", "audit"],
  fraud: ["identity", "audit"],
  notifications: ["identity"],
  orders: ["cart", "catalog", "pricing", "promotions", "inventory", "payments", "wallet", "fulfillment", "ledger", "fraud", "identity", "audit"],
  support: ["identity", "orders", "notifications", "audit"],
};
