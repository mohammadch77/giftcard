export type AuditActorType = "USER" | "ADMIN" | "SYSTEM" | "WORKER";

/** Who caused an action. System/worker actors use stable ids such as 'system:ledger' or 'worker:outbox'. */
export interface AuditActor {
  type: AuditActorType;
  id: string;
}

export interface AuditEntry {
  actor: AuditActor;
  /** dotted lowercase verb, e.g. 'ledger.post', 'ledger.reverse', 'ledger.account.create' */
  action: string;
  entity: { type: string; id: string };
  /** State before / after the change. Secrets must not be passed; sensitive keys are redacted anyway. */
  before?: unknown;
  after?: unknown;
  metadata?: unknown;
  requestId?: string | undefined;
  /** Business time of the action (from the injected Clock). */
  occurredAt: Date;
}

export interface AuditRecord {
  id: number;
  occurredAt: Date;
  actorType: AuditActorType;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  requestId: string | null;
  before: unknown;
  after: unknown;
  metadata: unknown;
}
