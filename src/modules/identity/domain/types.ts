import type { AuditActor } from "@/modules/audit";

export type UserKind = "CUSTOMER" | "STAFF";
export type UserStatus = "ACTIVE" | "SUSPENDED" | "CLOSED";

/** The authenticated principal handed to use cases. Lightweight: no profile data, no permission list. */
export interface Actor {
  userId: string;
  kind: UserKind;
  sessionId: string;
  /** users.authz_version at authentication time: key for the bounded permission cache. */
  authzVersion: number;
  sessionCreatedAt: Date;
  mfaVerifiedAt: Date | null;
  stepUpAt: Date | null;
}

export function toAuditActor(actor: Pick<Actor, "userId" | "kind">): AuditActor {
  return { type: actor.kind === "STAFF" ? "ADMIN" : "USER", id: actor.userId };
}

/** What a restricted staff session still has to do. */
export type MfaState = "NOT_REQUIRED" | "ENROLL_REQUIRED" | "TOTP_REQUIRED" | "COMPLETE";

export interface SessionGrant {
  /** Opaque bearer token — returned ONCE; only its digest is stored. */
  token: string;
  sessionId: string;
  userId: string;
  kind: UserKind;
  mfaState: MfaState;
  expiresAt: Date;
}

export type RequestOtpResult =
  | { status: "SENT"; expiresAt: Date; resendAfterSeconds: number }
  | { status: "RATE_LIMITED"; retryAfterSeconds: number }
  | { status: "DELIVERY_FAILED"; resendAfterSeconds: number };

export type VerifyOtpResult =
  | { status: "OK"; session: SessionGrant; newUser: boolean }
  | { status: "INVALID" } // wrong, expired, locked, consumed, unknown: deliberately indistinguishable
  | { status: "RATE_LIMITED"; retryAfterSeconds: number };

export interface SecurityContext {
  requestId?: string;
  /** Hashed/truncated by the caller (HTTP layer, Phase 4); stored as given, never a raw full IP. */
  ipPrefix?: string;
  userAgent?: string;
  /** Opaque per-client key used for the per-client OTP send limit (e.g. hashed IP). */
  clientKey?: string;
}
