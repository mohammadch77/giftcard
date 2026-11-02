/**
 * Module: audit — append-only audit log.
 * PUBLIC API of this module: the only file other code may import (enforced by dependency-cruiser).
 */
export const MODULE_NAME = "audit" as const;
export { recordAudit, listAudit } from "./application/audit-service";
export type { AuditQuery } from "./application/audit-service";
export type { AuditActor, AuditActorType, AuditEntry, AuditRecord } from "./domain/types";
