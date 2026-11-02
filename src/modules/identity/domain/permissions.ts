import { DomainError } from "@/platform/errors";

/**
 * Permission catalog. Permissions are CODE (single source of truth, reviewed in PRs); roles are DATA
 * (tables) that reference permission keys. A key not registered in the catalog is denied even if a
 * role row mentions it. Each module owns and registers ITS OWN permissions (e.g. the ledger registers
 * ledger.* at the composition root) — identity defines only identity.* keys.
 * There are NO wildcards: a role never receives a future permission implicitly.
 */
export interface PermissionDef {
  /** module.resource.action, lowercase, 2–4 dot-separated parts. */
  key: string;
  description: string;
  /** Sensitive permissions require a fresh step-up (TOTP within the step-up window) for staff. */
  sensitive: boolean;
}

const KEY_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$/;

export class PermissionCatalog {
  private readonly defs = new Map<string, PermissionDef>();

  constructor(initial: readonly PermissionDef[] = IDENTITY_PERMISSIONS) {
    this.register(initial);
  }

  register(defs: readonly PermissionDef[]): void {
    for (const d of defs) {
      if (!KEY_RE.test(d.key)) throw new DomainError("INVALID_ARGUMENT", `invalid permission key: ${d.key}`);
      const existing = this.defs.get(d.key);
      if (existing) {
        if (existing.sensitive !== d.sensitive) throw new DomainError("INVALID_ARGUMENT", `conflicting registration for ${d.key}`);
        continue;
      }
      this.defs.set(d.key, Object.freeze({ ...d }));
    }
  }

  has(key: string): boolean {
    return this.defs.has(key);
  }
  get(key: string): PermissionDef | undefined {
    return this.defs.get(key);
  }
  all(): PermissionDef[] {
    return [...this.defs.values()];
  }
}

export const IDENTITY_PERMISSIONS: readonly PermissionDef[] = [
  { key: "identity.users.read", description: "View users (phone numbers masked)", sensitive: false },
  { key: "identity.users.read_unmasked", description: "View full phone numbers", sensitive: true },
  { key: "identity.users.suspend", description: "Suspend or reactivate a user account", sensitive: true },
  { key: "identity.staff.manage", description: "Create staff accounts", sensitive: true },
  { key: "identity.roles.manage", description: "Grant/revoke roles and role permissions", sensitive: true },
  { key: "identity.sessions.revoke", description: "Revoke another user's sessions", sensitive: true },
  { key: "identity.mfa.reset", description: "Request, approve and complete MFA recovery", sensitive: true },
];

/** Initial system roles (seeded by migration 0011; a test pins migration and code together). */
export const SYSTEM_ROLES: Readonly<Record<string, { description: string; permissions: readonly string[] }>> = {
  owner: { description: "Full access to every permission registered at seed time", permissions: IDENTITY_PERMISSIONS.map((p) => p.key) },
  security_admin: {
    description: "Identity and security administration, role management, MFA recovery",
    permissions: ["identity.users.read", "identity.users.read_unmasked", "identity.users.suspend", "identity.staff.manage", "identity.roles.manage", "identity.sessions.revoke", "identity.mfa.reset"],
  },
  support_agent: { description: "Limited customer identity read access (masked)", permissions: ["identity.users.read"] },
};
