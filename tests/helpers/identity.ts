import { bootstrapFirstOwner, createIdentity } from "@/modules/identity";
import type { Actor, Identity } from "@/modules/identity";
import { base32Decode, totp } from "@/modules/identity/domain/totp";
import { ManualClock } from "@/platform/clock/testing";
import { DevKeyProvider } from "@/platform/crypto/testing/dev-key-provider";
import type { DatabaseHandle } from "@/platform/db";
import { TestSmsProvider } from "@/platform/sms/testing/test-sms";
import { createDatabaseAsRole, createTestDatabase, createTestRoles } from "./db";
import type { TestDatabase } from "./db";

export interface IdentityFixture {
  t: TestDatabase;
  app: DatabaseHandle;
  clock: ManualClock;
  sms: TestSmsProvider;
  keys: DevKeyProvider;
  identity: Identity;
  /** Build another Identity instance on the same database (e.g. a second process / other config). */
  make(overrides?: Parameters<typeof createIdentity>[0] extends infer D ? Partial<D> : never): Identity;
}

/** Real PostgreSQL, ALL migrations, every service call runs as the least-privilege application role. */
export async function identityFixture(start = "2026-06-01T10:00:00Z", config?: Parameters<typeof createIdentity>[0]["config"]): Promise<IdentityFixture> {
  const t = await createTestDatabase();
  const roles = await createTestRoles(t);
  const app = createDatabaseAsRole(t, roles.appRole, 20);
  const clock = new ManualClock(start);
  const sms = new TestSmsProvider();
  const keys = DevKeyProvider.generate(1);
  const make: IdentityFixture["make"] = (o = {}) => createIdentity({ db: app.db, keys, sms, clock, ...(config ? { config } : {}), ...o });
  return { t, app, clock, sms, keys, identity: make(), make };
}

let phoneBase = 1_000_000;
export const newPhone = (): string => `+98912${String(++phoneBase).padStart(7, "0")}`;

/** Request + verify OTP for `phone`; returns the verify result (advances the clock past the cooldown first). */
export async function otpLogin(f: IdentityFixture, phone: string) {
  f.clock.advance(61_000);
  const r = await f.identity.requestOtp(phone);
  if (r.status !== "SENT") throw new Error(`request failed: ${r.status}`);
  const code = f.sms.lastCode(phone);
  if (!code) throw new Error("no code sent");
  return f.identity.verifyOtp(phone, code);
}

export async function customer(f: IdentityFixture, phone = newPhone()): Promise<{ actor: Actor; token: string; phone: string }> {
  const r = await otpLogin(f, phone);
  if (r.status !== "OK") throw new Error(`login failed: ${r.status}`);
  const actor = await f.identity.authenticate(r.session.token);
  if (!actor) throw new Error("authenticate failed");
  return { actor, token: r.session.token, phone };
}

/** Create the first owner through the operator bootstrap (owner connection), as in production. */
export async function bootstrapOwner(f: IdentityFixture, phone = newPhone()): Promise<string> {
  return (await bootstrapFirstOwner(f.t.db, f.clock, phone)).userId;
}

export interface StaffSession { actor: Actor; token: string; phone: string; userId: string; secret: Buffer | null }

/** Staff login (OTP) and, when `secret` is given, the TOTP step. Advances the clock 31 s before each TOTP so the step is unused. */
export async function staffLogin(f: IdentityFixture, phone: string, secret: Buffer | null = null): Promise<StaffSession> {
  const r = await otpLogin(f, phone);
  if (r.status !== "OK") throw new Error(`staff otp failed: ${r.status}`);
  let token = r.session.token;
  let actor = (await f.identity.authenticate(token))!;
  if (secret) {
    f.clock.advance(31_000);
    const m = await f.identity.verifyTotp(actor, totp(secret, f.clock.now()));
    if (m.status !== "OK") throw new Error(`totp failed: ${m.status}`);
    if (m.newToken) token = m.newToken;
    actor = (await f.identity.authenticate(token))!;
  }
  return { actor, token, phone, userId: actor.userId, secret };
}

/** Full enrolment for a staff member: OTP login -> begin -> confirm. Returns the completed session and recovery codes. */
export async function enrolStaff(f: IdentityFixture, phone: string): Promise<StaffSession & { recoveryCodes: string[] }> {
  const s = await staffLogin(f, phone);
  const b = await f.identity.beginTotpEnrollment(s.actor);
  const secret = base32Decode(b.secretBase32);
  const c = await f.identity.confirmTotpEnrollment(s.actor, totp(secret, f.clock.now()));
  if (c.status !== "OK" || !c.newToken || !c.recoveryCodes) throw new Error(`enrol failed: ${c.status}`);
  const actor = (await f.identity.authenticate(c.newToken))!;
  return { actor, token: c.newToken, phone, userId: actor.userId, secret, recoveryCodes: c.recoveryCodes };
}

/** A fresh-step-up session for an enrolled staff member (second login). */
export async function relogin(f: IdentityFixture, s: Pick<StaffSession, "phone" | "secret">): Promise<StaffSession> {
  return staffLogin(f, s.phone, s.secret);
}

export const errCode = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code ?? "OTHER";
  }
  return "NO_ERROR";
};
