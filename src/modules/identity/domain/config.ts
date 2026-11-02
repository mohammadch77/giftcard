/** Approved Phase 2b-3 parameters (one place; injected so tests can shrink them). */
export interface IdentityConfig {
  otp: { digits: 6; ttlSeconds: number; maxAttempts: number; cooldownSeconds: number; sendsPerHour: number; verifiesPerHour: number; clientSendsPerHour: number; globalSendsPerHour: number };
  session: {
    staff: { idleSeconds: number; absoluteSeconds: number };
    customer: { idleSeconds: number; absoluteSeconds: number };
    /** last_seen_at is refreshed at most this often (limits write load). */
    touchIntervalSeconds: number;
  };
  stepUpSeconds: number;
  mfa: { totpAttemptsPer5Min: number; recoveryAttemptsPer15Min: number; enrollmentSessionMaxAgeSeconds: number; recoveryCodeCount: number; recoveryApprovalSeconds: number };
  permissionCacheSize: number;
}

export const DEFAULT_IDENTITY_CONFIG: IdentityConfig = {
  otp: { digits: 6, ttlSeconds: 120, maxAttempts: 5, cooldownSeconds: 60, sendsPerHour: 5, verifiesPerHour: 30, clientSendsPerHour: 20, globalSendsPerHour: 2000 },
  session: {
    staff: { idleSeconds: 30 * 60, absoluteSeconds: 12 * 3600 },
    customer: { idleSeconds: 7 * 86400, absoluteSeconds: 30 * 86400 },
    touchIntervalSeconds: 60,
  },
  stepUpSeconds: 300,
  mfa: { totpAttemptsPer5Min: 10, recoveryAttemptsPer15Min: 5, enrollmentSessionMaxAgeSeconds: 900, recoveryCodeCount: 10, recoveryApprovalSeconds: 24 * 3600 },
  permissionCacheSize: 500,
};
