import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CATALOG_PERMISSIONS } from "@/modules/catalog";
import { INVENTORY_PERMISSIONS } from "@/modules/inventory";
import { PAYMENT_PERMISSIONS } from "@/modules/payments";
import { WALLET_PERMISSIONS } from "@/modules/wallet";
import { IDENTITY_PERMISSIONS, PermissionCatalog, SYSTEM_ROLES, bootstrapFirstOwner, createIdentity } from "@/modules/identity";
import { base32Decode, totp } from "@/modules/identity/domain/totp";
import { NullKeyProvider } from "@/platform/crypto";
import { pgCode } from "../helpers/db";
import { bootstrapOwner, customer, enrolStaff, errCode, identityFixture, newPhone, otpLogin, relogin, staffLogin } from "../helpers/identity";
import type { IdentityFixture, StaffSession } from "../helpers/identity";

const BIG = { otp: { sendsPerHour: 1000, verifiesPerHour: 1000, globalSendsPerHour: 100000 } };
let f: IdentityFixture;
let owner: StaffSession & { recoveryCodes: string[] };
const phoneOfOwner = newPhone();

beforeAll(async () => {
  f = await identityFixture("2026-06-01T10:00:00Z", BIG);
  await bootstrapOwner(f, phoneOfOwner);
  owner = await enrolStaff(f, phoneOfOwner);
});
afterAll(async () => {
  await f?.app.close();
  await f?.t.drop();
});

const ownerNow = () => relogin(f, owner);
const audit = async (action: string) => (await f.t.pool.query("select * from audit_logs where action = $1 order by id", [action])).rows;

/** Owner creates staff, grants `role`, staff enrols TOTP. */
async function staffWith(role: string): Promise<StaffSession & { recoveryCodes: string[] }> {
  const o = await ownerNow();
  const phone = newPhone();
  const { userId } = await f.identity.createStaff(o.actor, phone);
  await f.identity.grantRole(o.actor, userId, role);
  return enrolStaff(f, phone);
}

describe("first-owner bootstrap (operator script path)", () => {
  it("creates exactly one staff owner without any credential; refuses to run again; sessions/TOTP do not pre-exist", async () => {
    const owners = (await f.t.pool.query("select ur.granted_by, u.kind from user_roles ur join roles r on r.id = ur.role_id join users u on u.id = ur.user_id where r.name = 'owner'")).rows;
    expect(owners).toEqual([{ granted_by: null, kind: "STAFF" }]);
    expect(await errCode(bootstrapFirstOwner(f.t.db, f.clock, newPhone()))).toBe("IDENTITY_CONFLICT");
    expect((await audit("identity.owner.bootstrapped")).length).toBe(1);
  });
  it("refuses a phone that belongs to a customer; a fresh database can bootstrap", async () => {
    const g = await identityFixture();
    try {
      const c = await customer(g);
      expect(await errCode(bootstrapFirstOwner(g.t.db, g.clock, c.phone))).toBe("IDENTITY_CONFLICT");
      expect(await errCode(bootstrapFirstOwner(g.t.db, g.clock, "not a phone"))).toBe("PHONE_INVALID");
      await bootstrapFirstOwner(g.t.db, g.clock, newPhone());
    } finally {
      await g.app.close();
      await g.t.drop();
    }
  });
  it("migration seeds exactly the roles/permissions defined in code (no wildcard, no ledger.* in identity)", async () => {
    const r = (await f.t.pool.query("select r.name, array_agg(rp.permission order by rp.permission) perms from roles r join role_permissions rp on rp.role_id = r.id and rp.revoked_at is null group by r.name")).rows;
    const db = Object.fromEntries(r.map((x) => [x.name, x.perms]));
    // Later modules seed their own permissions for `owner` in their migrations (catalog 0013, inventory 0015, payments/wallet 0017); nothing else changes.
    const extra: Record<string, string[]> = { owner: [...CATALOG_PERMISSIONS, ...INVENTORY_PERMISSIONS, ...PAYMENT_PERMISSIONS, ...WALLET_PERMISSIONS].map((p) => p.key) };
    for (const [name, def] of Object.entries(SYSTEM_ROLES)) expect(db[name], name).toEqual([...def.permissions, ...(extra[name] ?? [])].sort());
    expect(Object.keys(db).sort()).toEqual(["owner", "security_admin", "support_agent"]);
    expect(JSON.stringify(db)).not.toMatch(/ledger|\*/);
  });
});

describe("staff login is restricted until MFA completes", () => {
  it("a staff session after OTP only reports ENROLL_REQUIRED/TOTP_REQUIRED and every permission is refused (MFA_REQUIRED)", async () => {
    const o = await ownerNow();
    const phone = newPhone();
    const { userId } = await f.identity.createStaff(o.actor, phone);
    await f.identity.grantRole(o.actor, userId, "support_agent");
    const r = await otpLogin(f, phone);
    expect(r).toMatchObject({ status: "OK", session: { kind: "STAFF", mfaState: "ENROLL_REQUIRED" } });
    if (r.status !== "OK") return;
    const actor = (await f.identity.authenticate(r.session.token))!;
    expect(actor.mfaVerifiedAt).toBeNull();
    expect(await errCode(f.identity.authorize(actor, "identity.users.read"))).toBe("AUTH_MFA_REQUIRED");
    expect(await f.identity.can(actor, "identity.users.read")).toBe(false);
    const again = await otpLogin(f, owner.phone);
    expect(again.status === "OK" && again.session.mfaState).toBe("TOTP_REQUIRED");
  });
  it("customers and unknown permissions are always denied (deny by default)", async () => {
    const c = await customer(f);
    expect(await errCode(f.identity.authorize(c.actor, "identity.users.read"))).toBe("AUTH_FORBIDDEN");
    const o = await ownerNow();
    expect(await errCode(f.identity.authorize(o.actor, "no.such.permission"))).toBe("AUTH_FORBIDDEN");
  });
  it("createStaff never turns an existing customer into staff and a phone alone never grants staff", async () => {
    const o = await ownerNow();
    const c = await customer(f);
    expect(await errCode(f.identity.createStaff(o.actor, c.phone))).toBe("IDENTITY_CONFLICT");
    const r = await otpLogin(f, newPhone());
    expect(r.status === "OK" && r.session.kind).toBe("CUSTOMER");
  });
});

describe("TOTP enrolment, verification and replay", () => {
  it("enrolment: secret is stored sealed, token rotates, recovery codes are shown once and stored as digests only", async () => {
    const phone = newPhone();
    const o = await ownerNow();
    const { userId } = await f.identity.createStaff(o.actor, phone);
    await f.identity.grantRole(o.actor, userId, "support_agent");
    const s = await staffLogin(f, phone);
    const b = await f.identity.beginTotpEnrollment(s.actor);
    expect(b.otpauthUri).toContain(`secret=${b.secretBase32}`);
    const secret = base32Decode(b.secretBase32);
    const stored = (await f.t.pool.query("select secret_sealed, status from admin_totp where user_id = $1", [userId])).rows[0];
    expect(stored.status).toBe("PENDING");
    expect(stored.secret_sealed.includes(secret)).toBe(false);
    expect(stored.secret_sealed.toString("latin1")).not.toContain(b.secretBase32);
    const wrong = totp(secret, new Date(f.clock.now().getTime() + 120_000));
    expect((await f.identity.confirmTotpEnrollment(s.actor, wrong)).status).toBe("INVALID");
    const c = await f.identity.confirmTotpEnrollment(s.actor, totp(secret, f.clock.now()));
    expect(c.status).toBe("OK");
    if (c.status !== "OK") return;
    expect(c.recoveryCodes).toHaveLength(10);
    expect(await f.identity.authenticate(s.token)).toBeNull(); // old token dead: rotated on MFA completion (fixation defence)
    const a2 = (await f.identity.authenticate(c.newToken!))!;
    expect(a2.mfaVerifiedAt).not.toBeNull();
    expect(a2.stepUpAt).not.toBeNull();
    expect(await f.identity.can(a2, "identity.users.read")).toBe(true);
    const dump = JSON.stringify((await f.t.pool.query("select * from admin_recovery_codes where user_id = $1", [userId])).rows);
    for (const code of c.recoveryCodes!) expect(dump).not.toContain(code.replace(/-/g, ""));
    expect((await f.t.pool.query("select count(*)::int c from admin_recovery_codes where user_id = $1 and used_at is null", [userId])).rows[0].c).toBe(10);
  });
  it("fails closed with no key provider (production default): no enrolment, nothing stored", async () => {
    const phone = newPhone();
    const o = await ownerNow();
    const { userId } = await f.identity.createStaff(o.actor, phone);
    const s = await staffLogin(f, phone);
    const prod = createIdentity({ db: f.app.db, keys: new NullKeyProvider(), sms: f.sms, clock: f.clock });
    expect(await errCode(prod.beginTotpEnrollment(s.actor))).toBe("KEY_PROVIDER_NOT_CONFIGURED");
    expect((await f.t.pool.query("select count(*)::int c from admin_totp where user_id = $1", [userId])).rows[0].c).toBe(0);
  });
  it("first enrolment needs a recent login; replacing an authenticator needs a fresh step-up", async () => {
    const phone = newPhone();
    const o = await ownerNow();
    await f.identity.createStaff(o.actor, phone);
    const s = await staffLogin(f, phone);
    f.clock.advance(16 * 60_000);
    expect(await errCode(f.identity.beginTotpEnrollment(s.actor))).toBe("AUTH_STEP_UP_REQUIRED");
    const stale = await relogin(f, owner);
    f.clock.advance(6 * 60_000);
    expect(await errCode(f.identity.beginTotpEnrollment(stale.actor))).toBe("AUTH_STEP_UP_REQUIRED");
  });
  it("login second factor rotates the token; a used code can never be replayed (same step or earlier step)", async () => {
    const mk = async () => {
      const r = await otpLogin(f, owner.phone);
      if (r.status !== "OK") throw new Error("x");
      return r.session.token;
    };
    const t1 = await mk();
    const t2 = await mk();
    const a1 = (await f.identity.authenticate(t1))!;
    const a2 = (await f.identity.authenticate(t2))!;
    f.clock.advance(31_000);
    const code = totp(owner.secret!, f.clock.now());
    const earlier = totp(owner.secret!, new Date(f.clock.now().getTime() - 30_000));
    expect(await f.identity.verifyTotp(a1, code)).toMatchObject({ status: "OK" });
    expect(await f.identity.authenticate(t1)).toBeNull(); // rotated
    expect(await f.identity.verifyTotp(a2, code)).toEqual({ status: "INVALID" }); // same step: replay
    expect(await f.identity.verifyTotp(a2, earlier)).toEqual({ status: "INVALID" }); // older step than the last used one
    f.clock.advance(30_000);
    expect(await f.identity.verifyTotp(a2, totp(owner.secret!, f.clock.now()))).toMatchObject({ status: "OK" });
  });
  it("wrong codes are audited and rate limited (10 per 5 minutes); not-enrolled users are told so", async () => {
    const s = await staffWith("support_agent");
    const r = await otpLogin(f, s.phone);
    if (r.status !== "OK") throw new Error("x");
    const actor = (await f.identity.authenticate(r.session.token))!;
    const out: string[] = [];
    for (let i = 0; i < 11; i++) out.push((await f.identity.verifyTotp(actor, "000000")).status);
    expect(out.filter((x) => x === "RATE_LIMITED").length).toBeGreaterThanOrEqual(1);
    expect((await audit("identity.mfa.failed")).length).toBeGreaterThanOrEqual(9);
    const phone = newPhone();
    const o = await ownerNow();
    await f.identity.createStaff(o.actor, phone);
    const fresh = await staffLogin(f, phone);
    expect((await f.identity.verifyTotp(fresh.actor, "123456")).status).toBe("NOT_ENROLLED");
  });
});

describe("authorization and step-up are enforced centrally", () => {
  it("every sensitive permission requires a fresh step-up; non-sensitive ones do not", async () => {
    const o = await ownerNow();
    f.clock.advance(6 * 60_000);
    for (const p of IDENTITY_PERMISSIONS) {
      const code = await errCode(f.identity.authorize(o.actor, p.key));
      expect(code, p.key).toBe(p.sensitive ? "AUTH_STEP_UP_REQUIRED" : "NO_ERROR");
    }
    const fresh = await ownerNow();
    for (const p of IDENTITY_PERMISSIONS) expect(await errCode(f.identity.authorize(fresh.actor, p.key)), p.key).toBe("NO_ERROR");
  });
  it("step-up window is exactly 5 minutes", async () => {
    const o = await ownerNow();
    f.clock.advance(299_000);
    expect(await errCode(f.identity.authorize(o.actor, "identity.staff.manage"))).toBe("NO_ERROR");
    f.clock.advance(2_000);
    expect(await errCode(f.identity.authorize(o.actor, "identity.staff.manage"))).toBe("AUTH_STEP_UP_REQUIRED");
    const again = await f.identity.verifyTotp(o.actor, totp(owner.secret!, f.clock.now()));
    expect(again.status).toBe("OK");
  });
  it("unregistered permissions in role data are ignored; modules register their own at the composition root", async () => {
    const s = await staffWith("support_agent");
    await f.t.pool.query("insert into role_permissions (id, role_id, permission, granted_at) select gen_random_uuid(), id, 'ledger.entries.read', now() from roles where name = 'support_agent'");
    expect(await f.identity.can(s.actor, "ledger.entries.read")).toBe(false);
    const catalog = new PermissionCatalog();
    catalog.register([{ key: "ledger.entries.read", description: "owned by ledger", sensitive: false }]);
    const withLedger = createIdentity({ db: f.app.db, keys: f.keys, sms: f.sms, clock: f.clock, catalog });
    const a = (await withLedger.authenticate(s.token))!;
    expect(await withLedger.can(a, "ledger.entries.read")).toBe(true);
    expect(await withLedger.can(a, "identity.staff.manage")).toBe(false);
    await f.t.pool.query("delete from role_permissions where permission = 'ledger.entries.read'"); // test-only cleanup as owner
  });
  it("permission cache is keyed by authz_version: a role revocation applies on the very next request", async () => {
    const s = await staffWith("security_admin");
    expect(await f.identity.can(s.actor, "identity.users.read")).toBe(true);
    let queries = 0;
    const counting = new Proxy(f.app.db, { get: (t, p, r) => (p === "execute" ? (...a: unknown[]) => (queries++, (t.execute as (...x: unknown[]) => unknown)(...a)) : Reflect.get(t, p, r)) });
    const id = createIdentity({ db: counting, keys: f.keys, sms: f.sms, clock: f.clock });
    const a1 = (await id.authenticate(s.token))!;
    queries = 0;
    await id.can(a1, "identity.users.read");
    await id.can(a1, "identity.users.suspend");
    expect(queries).toBe(1); // second check served from the bounded cache
    const o = await ownerNow();
    const before = Number((await f.t.pool.query("select authz_version v from users where id = $1", [s.userId])).rows[0].v);
    await f.identity.revokeRole(o.actor, s.userId, "security_admin");
    expect(Number((await f.t.pool.query("select authz_version v from users where id = $1", [s.userId])).rows[0].v)).toBe(before + 1);
    const a2 = (await f.identity.authenticate(s.token))!;
    expect(a2.authzVersion).toBe(before + 1);
    expect(await f.identity.can(a2, "identity.users.read")).toBe(false);
  });
});

describe("role management (no self-promotion, no escalation)", () => {
  it("cannot grant or revoke your own roles; DB CHECK also forbids self-grant", async () => {
    const o = await ownerNow();
    expect(await errCode(f.identity.grantRole(o.actor, o.userId, "owner"))).toBe("AUTH_FORBIDDEN");
    expect(await errCode(f.identity.revokeRole(o.actor, o.userId, "owner"))).toBe("AUTH_FORBIDDEN");
    const res = await f.t.pool.query("insert into user_roles (id, user_id, role_id, granted_by, granted_at) select gen_random_uuid(), $1, id, $1, now() from roles where name='support_agent'", [o.userId]).then(() => "ok", (e: unknown) => pgCode(e));
    expect(res).toBe("23514");
  });
  it("roles go to staff only (application and database); granting is audited and idempotent", async () => {
    const o = await ownerNow();
    const c = await customer(f);
    expect(await errCode(f.identity.grantRole(o.actor, c.actor.userId, "support_agent"))).toBe("IDENTITY_CONFLICT");
    const r = await f.t.pool.query("insert into user_roles (id, user_id, role_id, granted_at) select gen_random_uuid(), $1, id, now() from roles where name='support_agent'", [c.actor.userId]).then(() => "ok", (e: unknown) => pgCode(e));
    expect(r).toBe("PI002");
    const phone = newPhone();
    const { userId } = await f.identity.createStaff(o.actor, phone);
    await f.identity.grantRole(o.actor, userId, "support_agent");
    await f.identity.grantRole(o.actor, userId, "support_agent");
    expect((await audit("identity.role.granted")).filter((a) => a.entity_id === userId)).toHaveLength(1);
    expect(await errCode(f.identity.grantRole(o.actor, userId, "no_such_role"))).toBe("IDENTITY_NOT_FOUND");
  });
  it("an actor cannot grant a role carrying permissions they do not hold (future permissions never leak sideways)", async () => {
    const secAdmin = await staffWith("security_admin");
    const o = await ownerNow();
    // A new module permission is given to the owner role only.
    const catalog = new PermissionCatalog();
    catalog.register([{ key: "ledger.adjust", description: "owned by ledger", sensitive: true }]);
    const id = createIdentity({ db: f.app.db, keys: f.keys, sms: f.sms, clock: f.clock, catalog });
    const oa = (await id.authenticate(o.token))!;
    await f.t.pool.query("insert into role_permissions (id, role_id, permission, granted_at) select gen_random_uuid(), id, 'ledger.adjust', now() from roles where name='owner'");
    const oNew = (await id.authenticate(o.token))!;
    void oa;
    expect(await id.can(oNew, "ledger.adjust")).toBe(true);
    const sa = await relogin(f, secAdmin);
    const saActor = (await id.authenticate(sa.token))!;
    expect(await id.can(saActor, "ledger.adjust")).toBe(false); // security_admin did not receive it implicitly
    const target = await staffWith("support_agent");
    expect(await errCode(id.grantRole(saActor, target.userId, "owner"))).toBe("AUTH_FORBIDDEN");
    expect(await errCode(id.grantRolePermission(saActor, "support_agent", "ledger.adjust"))).toBe("AUTH_FORBIDDEN");
    await f.t.pool.query("delete from role_permissions where permission = 'ledger.adjust'"); // test-only cleanup as owner
  });
  it("role-permission changes: registered keys only, never on a role you hold; effective immediately for holders", async () => {
    const o = await ownerNow();
    const agent = await staffWith("support_agent");
    expect(await errCode(f.identity.grantRolePermission(o.actor, "support_agent", "made.up.perm"))).toBe("INVALID_ARGUMENT");
    expect(await errCode(f.identity.grantRolePermission(o.actor, "owner", "identity.users.read"))).toBe("AUTH_FORBIDDEN"); // the owner holds `owner`
    await f.identity.grantRolePermission(o.actor, "support_agent", "identity.users.read_unmasked");
    const a1 = (await f.identity.authenticate(agent.token))!;
    expect(await f.identity.can(a1, "identity.users.read")).toBe(true);
    await f.identity.revokeRolePermission(o.actor, "support_agent", "identity.users.read_unmasked");
    expect(await errCode(f.identity.revokeRolePermission(o.actor, "support_agent", "identity.users.read_unmasked"))).toBe("NO_ERROR"); // idempotent
    expect((await audit("identity.role.permission_granted")).length).toBeGreaterThanOrEqual(1);
  });
  it("the last active owner can be neither demoted nor suspended", async () => {
    const o = await ownerNow();
    const admin = await staffWith("security_admin");
    const fresh = await relogin(f, admin);
    expect(await errCode(f.identity.revokeRole(fresh.actor, o.userId, "owner"))).toBe("IDENTITY_CONFLICT");
    expect(await errCode(f.identity.setUserStatus(fresh.actor, o.userId, "SUSPENDED", "testing the guard"))).toBe("IDENTITY_CONFLICT");
  });
});

describe("user administration and support-safe reads", () => {
  it("suspending a staff user revokes their sessions at once, records history with the actor, and is reversible", async () => {
    const o = await ownerNow();
    const agent = await staffWith("support_agent");
    expect(await errCode(f.identity.setUserStatus(o.actor, o.userId, "SUSPENDED", "never allowed on self"))).toBe("AUTH_FORBIDDEN");
    expect(await errCode(f.identity.setUserStatus(o.actor, agent.userId, "SUSPENDED", "x"))).toBe("INVALID_ARGUMENT");
    await f.identity.setUserStatus(o.actor, agent.userId, "SUSPENDED", "policy violation #1");
    expect(await f.identity.authenticate(agent.token)).toBeNull();
    const hist = (await f.t.pool.query("select from_status, to_status, actor_id, reason from user_status_history where entity_id = $1 order by id", [agent.userId])).rows;
    expect(hist.at(-1)).toEqual({ from_status: "ACTIVE", to_status: "SUSPENDED", actor_id: o.userId, reason: "policy violation #1" });
    expect(await otpLogin(f, agent.phone)).toEqual({ status: "INVALID" });
    await f.identity.setUserStatus(o.actor, agent.userId, "ACTIVE", "appeal accepted");
    expect((await otpLogin(f, agent.phone)).status).toBe("OK");
  });
  it("support sees masked phones; an owner sees the full number only with a fresh step-up, and that read is audited", async () => {
    const agent = await staffWith("support_agent");
    const c = await customer(f);
    const s1 = await f.identity.getUserSummary(agent.actor, c.actor.userId);
    expect(s1).toMatchObject({ phoneMasked: true });
    expect(s1.phone).toBe(`${c.phone.slice(0, 6)}***${c.phone.slice(-4)}`);
    const o = await ownerNow();
    expect((await f.identity.getUserSummary(o.actor, c.actor.userId)).phone).toBe(c.phone);
    expect((await audit("identity.user.viewed_unmasked")).some((a) => a.entity_id === c.actor.userId && a.actor_id === o.userId)).toBe(true);
    f.clock.advance(6 * 60_000);
    expect((await f.identity.getUserSummary(o.actor, c.actor.userId)).phoneMasked).toBe(true);
  });
});

describe("recovery codes", () => {
  it("each code works exactly once; formatting is forgiven; used count is reported", async () => {
    const s = await staffWith("support_agent");
    const r = await otpLogin(f, s.phone);
    if (r.status !== "OK") throw new Error("x");
    const actor = (await f.identity.authenticate(r.session.token))!;
    const [c1, c2] = s.recoveryCodes;
    expect(await f.identity.verifyRecoveryCode(actor, c1!.toLowerCase().replace(/-/g, " "))).toMatchObject({ status: "OK", remaining: 9 });
    const r2 = await otpLogin(f, s.phone);
    if (r2.status !== "OK") throw new Error("x");
    const a2 = (await f.identity.authenticate(r2.session.token))!;
    expect(await f.identity.verifyRecoveryCode(a2, c1!)).toEqual({ status: "INVALID" });
    expect(await f.identity.verifyRecoveryCode(a2, "ABCD-EFGH-JKLM-NPQR")).toEqual({ status: "INVALID" });
    expect(await f.identity.verifyRecoveryCode(a2, c2!)).toMatchObject({ status: "OK", remaining: 8 });
    expect((await audit("identity.mfa.recovery_code_used")).length).toBeGreaterThanOrEqual(2);
    const sess = (await f.t.pool.query("select mfa_method from user_sessions where user_id = $1 order by created_at desc limit 1", [s.userId])).rows[0];
    expect(sess.mfa_method).toBe("RECOVERY_CODE");
  });
  it("attempts are limited (5 per 15 minutes) and used_at is set-once in the database", async () => {
    const s = await staffWith("support_agent");
    const r = await otpLogin(f, s.phone);
    if (r.status !== "OK") throw new Error("x");
    const actor = (await f.identity.authenticate(r.session.token))!;
    const out: string[] = [];
    for (let i = 0; i < 7; i++) out.push((await f.identity.verifyRecoveryCode(actor, "ABCD-EFGH-JKLM-NPQR")).status);
    expect(out).toEqual(["INVALID", "INVALID", "INVALID", "INVALID", "INVALID", "RATE_LIMITED", "RATE_LIMITED"]);
    f.clock.advance(901_000);
    const ok = await f.identity.verifyRecoveryCode(actor, s.recoveryCodes[0]!);
    expect(ok.status).toBe("OK");
    const hack = await f.t.pool.query("update admin_recovery_codes set used_at = null where user_id = $1", [s.userId]).then(() => "ok", (e: unknown) => pgCode(e));
    expect(hack).toBe("PI001");
  });
  it("regeneration needs step-up and invalidates every previous code", async () => {
    const s = await staffWith("support_agent");
    const fresh = await relogin(f, s);
    f.clock.advance(6 * 60_000);
    expect(await errCode(f.identity.regenerateRecoveryCodes(fresh.actor))).toBe("AUTH_STEP_UP_REQUIRED");
    const again = await relogin(f, s);
    const codes = await f.identity.regenerateRecoveryCodes(again.actor);
    expect(codes).toHaveLength(10);
    const r = await otpLogin(f, s.phone);
    if (r.status !== "OK") throw new Error("x");
    const a = (await f.identity.authenticate(r.session.token))!;
    expect(await f.identity.verifyRecoveryCode(a, s.recoveryCodes[0]!)).toEqual({ status: "INVALID" });
    expect((await f.identity.verifyRecoveryCode(a, codes[0]!)).status).toBe("OK");
  });
});

describe("MFA recovery (restricted, manual, audited)", () => {
  it("full flow: request -> independent approval -> completion retires the authenticator and all sessions; target re-enrols", async () => {
    const target = await staffWith("support_agent");
    const approver = await staffWith("security_admin");
    const o = await ownerNow();
    expect(await errCode(f.identity.requestMfaRecovery(o.actor, target.userId, "short"))).toBe("INVALID_ARGUMENT");
    expect(await errCode(f.identity.requestMfaRecovery(o.actor, o.userId, "lost phone and codes"))).toBe("AUTH_FORBIDDEN");
    const { requestId } = await f.identity.requestMfaRecovery(o.actor, target.userId, "phone lost, identity verified in person");
    expect(await errCode(f.identity.requestMfaRecovery(o.actor, target.userId, "second open request attempt"))).toBe("IDENTITY_CONFLICT");
    expect(await errCode(f.identity.approveMfaRecovery(o.actor, requestId, "I requested it myself"))).toBe("AUTH_FORBIDDEN");
    expect(await errCode(f.identity.completeMfaRecovery(o.actor, requestId))).toBe("MFA_STATE_INVALID"); // not approved yet
    const ap = await relogin(f, approver);
    expect(await errCode(f.identity.approveMfaRecovery(ap.actor, requestId, "short"))).toBe("INVALID_ARGUMENT");
    await f.identity.approveMfaRecovery(ap.actor, requestId, "verified ID document at the office");
    const o2 = await ownerNow();
    await f.identity.completeMfaRecovery(o2.actor, requestId);

    expect(await f.identity.authenticate(target.token)).toBeNull();
    const t = (await f.t.pool.query("select status from admin_totp where user_id = $1 order by created_at", [target.userId])).rows.map((x) => x.status);
    expect(t.at(-1)).toBe("REPLACED");
    expect((await f.t.pool.query("select count(*)::int c from admin_recovery_codes where user_id = $1 and used_at is null and superseded_at is null", [target.userId])).rows[0].c).toBe(0);
    const hist = (await f.t.pool.query("select to_status, actor_id from mfa_recovery_history where entity_id = $1 order by id", [requestId])).rows;
    expect(hist.map((h) => h.to_status)).toEqual(["REQUESTED", "APPROVED", "COMPLETED"]);
    expect(hist.map((h) => h.actor_id)).toEqual([o.userId, ap.userId, o2.userId]);
    expect((await f.t.pool.query("select 1 from outbox_events where event_type = 'identity.mfa_recovery.completed' and aggregate_id = $1", [target.userId])).rows).toHaveLength(1);
    for (const a of ["requested", "approved", "completed"]) expect((await audit(`identity.mfa_recovery.${a}`)).length).toBeGreaterThanOrEqual(1);

    const r = await otpLogin(f, target.phone);
    expect(r.status === "OK" && r.session.mfaState).toBe("ENROLL_REQUIRED");
    const re = await enrolStaff(f, target.phone);
    expect(re.actor.mfaVerifiedAt).not.toBeNull();
  });
  it("the target can never decide their own request; approvals expire after 24 h (no MFA change happens)", async () => {
    const target = await staffWith("security_admin");
    const o = await ownerNow();
    const { requestId } = await f.identity.requestMfaRecovery(o.actor, target.userId, "device destroyed, verified by video call");
    const t = await relogin(f, target);
    expect(await errCode(f.identity.approveMfaRecovery(t.actor, requestId, "approving my own recovery"))).toBe("AUTH_FORBIDDEN");
    expect(await errCode(f.identity.rejectMfaRecovery(t.actor, requestId, "rejecting my own recovery"))).toBe("AUTH_FORBIDDEN");
    const other = await staffWith("security_admin");
    const ap = await relogin(f, other);
    await f.identity.approveMfaRecovery(ap.actor, requestId, "approved after verification call");
    f.clock.advance(25 * 3600_000);
    const o2 = await ownerNow();
    expect(await errCode(f.identity.completeMfaRecovery(o2.actor, requestId))).toBe("MFA_STATE_INVALID");
    expect((await f.t.pool.query("select status from mfa_recovery_requests where id = $1", [requestId])).rows[0].status).toBe("EXPIRED");
    expect((await f.t.pool.query("select status from admin_totp where user_id = $1 order by created_at desc limit 1", [target.userId])).rows[0].status).toBe("ACTIVE");
    const { requestId: again } = await f.identity.requestMfaRecovery(o2.actor, target.userId, "retry after expiry of previous");
    const ap2 = await relogin(f, other);
    await f.identity.rejectMfaRecovery(ap2.actor, again, "evidence insufficient");
    expect((await f.t.pool.query("select status from mfa_recovery_requests where id = $1", [again])).rows[0].status).toBe("REJECTED");
  });
  it("database constraints back the rules: self-approval, short reasons, customer targets and forged statuses are impossible", async () => {
    const target = await staffWith("support_agent");
    const o = await ownerNow();
    const { requestId } = await f.identity.requestMfaRecovery(o.actor, target.userId, "reason long enough here");
    const run = (q: string, p: unknown[]) => f.t.pool.query(q, p).then(() => "ok", (e: unknown) => pgCode(e));
    expect(await run("update mfa_recovery_requests set status='APPROVED', approved_by=requested_by, approval_reason='long enough reason', approved_at=now(), approval_expires_at=now() where id=$1", [requestId])).toBe("23514");
    expect(await run("update mfa_recovery_requests set status='COMPLETED' where id=$1", [requestId])).toBe("PT001"); // REQUESTED -> COMPLETED is not a transition
    expect(await run("update mfa_recovery_requests set reason='tampered reason text' where id=$1", [requestId])).toBe("PI001");
    expect(await f.app.pool.query("delete from mfa_recovery_history").then(() => "ok", (e: unknown) => pgCode(e))).toBe("42501");
  });
});

describe("audit coverage and secret hygiene", () => {
  it("administrative and security events were audited, and no secret ever reached the audit log", async () => {
    const actions = new Set((await f.t.pool.query("select distinct action from audit_logs")).rows.map((r) => r.action as string));
    for (const a of ["identity.owner.bootstrapped", "identity.session.created", "identity.mfa.enrollment_started", "identity.mfa.enrolled", "identity.mfa.verified", "identity.mfa.step_up", "identity.mfa.failed",
      "identity.staff.created", "identity.role.granted", "identity.role.revoked", "identity.user.status_changed", "identity.mfa.recovery_code_used", "identity.mfa_recovery.completed", "identity.user.registered"]) {
      expect(actions.has(a), a).toBe(true);
    }
    const all = JSON.stringify((await f.t.pool.query("select * from audit_logs")).rows) + JSON.stringify((await f.t.pool.query("select * from outbox_events")).rows);
    for (const code of owner.recoveryCodes) expect(all).not.toContain(code.replace(/-/g, ""));
    expect(all).not.toContain(owner.token);
    expect(all).not.toMatch(/\+989\d{9}/); // no full phone numbers in audit or outbox
    expect(all).not.toContain(owner.secret!.toString("base64"));
    const staffRows = (await f.t.pool.query("select actor_type from audit_logs where action like 'identity.role.%'")).rows;
    expect(staffRows.every((r) => r.actor_type === "ADMIN")).toBe(true);
  });
});
