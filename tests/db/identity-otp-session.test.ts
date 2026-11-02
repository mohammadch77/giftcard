import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NullKeyProvider } from "@/platform/crypto";
import { NullSmsProvider } from "@/platform/sms";
import { pgCode } from "../helpers/db";
import { customer, errCode, identityFixture, newPhone, otpLogin } from "../helpers/identity";
import type { IdentityFixture } from "../helpers/identity";

let f: IdentityFixture;
beforeAll(async () => {
  f = await identityFixture();
});
afterAll(async () => {
  await f?.app.close();
  await f?.t.drop();
});

const challenge = async (phone: string) => (await f.t.pool.query("select * from otp_challenges where phone = $1 order by created_at desc, id desc limit 1", [phone])).rows[0];
const send = async (phone: string) => {
  f.clock.advance(61_000);
  return f.identity.requestOtp(phone);
};

describe("OTP request", () => {
  it("creates a SENT challenge, sends a 6-digit code once, stores only a keyed 32-byte digest (no plaintext anywhere)", async () => {
    const phone = newPhone();
    const r = await f.identity.requestOtp(phone);
    expect(r).toMatchObject({ status: "SENT", resendAfterSeconds: 60 });
    const code = f.sms.lastCode(phone)!;
    expect(code).toMatch(/^\d{6}$/);
    expect(f.sms.sent.filter((m) => m.to === phone)).toHaveLength(1);
    const ch = await challenge(phone);
    expect(ch.status).toBe("SENT");
    expect(ch.sent_at).not.toBeNull();
    expect(ch.code_digest.length).toBe(32);
    const dump = JSON.stringify((await f.t.pool.query("select * from otp_challenges")).rows) + JSON.stringify((await f.t.pool.query("select * from audit_logs")).rows) + JSON.stringify((await f.t.pool.query("select * from rate_limit_counters")).rows);
    expect(dump).not.toContain(code);
    expect(JSON.stringify((await f.t.pool.query("select * from rate_limit_counters")).rows)).not.toContain(phone.slice(3)); // keys are hashed: no phone in counters
  });
  it("is enumeration-safe: unknown and known phones get an identical response shape", async () => {
    const known = (await customer(f)).phone;
    f.clock.advance(61_000);
    const a = await f.identity.requestOtp(known);
    const b = await f.identity.requestOtp(newPhone());
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    expect(a.status).toBe(b.status);
  });
  it("enforces the 60 s cooldown (exact, from the DB) and supersedes the previous code on resend", async () => {
    const phone = newPhone();
    await f.identity.requestOtp(phone);
    const first = f.sms.lastCode(phone)!;
    f.clock.advance(30_000);
    const r = await f.identity.requestOtp(phone);
    expect(r).toMatchObject({ status: "RATE_LIMITED" });
    expect((r as { retryAfterSeconds: number }).retryAfterSeconds).toBe(30);
    expect(f.sms.sent.filter((m) => m.to === phone)).toHaveLength(1); // no SMS for a limited request
    f.clock.advance(31_000);
    expect((await f.identity.requestOtp(phone)).status).toBe("SENT");
    const second = f.sms.lastCode(phone)!;
    const states = (await f.t.pool.query("select status from otp_challenges where phone = $1 order by created_at", [phone])).rows.map((x) => x.status);
    expect(states).toEqual(["SUPERSEDED", "SENT"]);
    if (first !== second) expect(await f.identity.verifyOtp(phone, first)).toEqual({ status: "INVALID" });
    expect((await f.identity.verifyOtp(phone, second)).status).toBe("OK");
  });
  it("allows at most 5 sends per phone per hour", async () => {
    const phone = newPhone();
    const results: string[] = [];
    for (let i = 0; i < 6; i++) results.push((await send(phone)).status);
    expect(results).toEqual(["SENT", "SENT", "SENT", "SENT", "SENT", "RATE_LIMITED"]);
  });
  it("applies the per-client limit when a client key is supplied", async () => {
    const small = f.make({ config: { otp: { clientSendsPerHour: 2 } } });
    const res: string[] = [];
    for (let i = 0; i < 3; i++) {
      f.clock.advance(61_000);
      res.push((await small.requestOtp(newPhone(), { clientKey: "client-a" })).status);
    }
    expect(res).toEqual(["SENT", "SENT", "RATE_LIMITED"]);
  });
  it("rejects malformed phone numbers before any side effect", async () => {
    const before = f.sms.sent.length;
    await expect(f.identity.requestOtp("12345")).rejects.toMatchObject({ code: "PHONE_INVALID" });
    expect(f.sms.sent.length).toBe(before);
  });
});

describe("SMS delivery failure handling (send happens after commit, outside the transaction)", () => {
  it("definitive provider rejection: challenge FAILED (cannot verify), immediate safe resend works", async () => {
    const phone = newPhone();
    f.sms.mode = "reject";
    const r = await f.identity.requestOtp(phone);
    f.sms.mode = "ok";
    expect(r).toEqual({ status: "DELIVERY_FAILED", resendAfterSeconds: 0 });
    expect((await challenge(phone)).status).toBe("FAILED");
    expect(await f.identity.verifyOtp(phone, "123456")).toEqual({ status: "INVALID" });
    const again = await f.identity.requestOtp(phone); // no clock advance: failed sends do not trigger the cooldown
    expect(again.status).toBe("SENT");
    expect((await f.identity.verifyOtp(phone, f.sms.lastCode(phone)!)).status).toBe("OK");
  });
  it("unknown outcome (provider throws): challenge stays verifiable, caller sees SENT and the normal cooldown", async () => {
    const phone = newPhone();
    f.sms.mode = "throw";
    const r = await f.identity.requestOtp(phone);
    f.sms.mode = "ok";
    expect(r.status).toBe("SENT");
    const ch = await challenge(phone);
    expect(ch.status).toBe("PENDING");
    expect(f.sms.sent.filter((m) => m.to === phone)).toHaveLength(0);
    expect((await f.identity.requestOtp(phone)).status).toBe("RATE_LIMITED");
  });
  it("no SMS provider configured: challenge marked FAILED and the configuration error is surfaced", async () => {
    const phone = newPhone();
    const id = f.make({ sms: new NullSmsProvider() });
    f.clock.advance(61_000);
    expect(await errCode(id.requestOtp(phone))).toBe("SMS_PROVIDER_NOT_CONFIGURED");
    expect((await challenge(phone)).status).toBe("FAILED");
  });
  it("no key provider configured (production default): fails closed BEFORE any write or SMS", async () => {
    const phone = newPhone();
    const id = f.make({ keys: new NullKeyProvider() });
    const sent = f.sms.sent.length;
    expect(await errCode(id.requestOtp(phone))).toBe("KEY_PROVIDER_NOT_CONFIGURED");
    expect(await challenge(phone)).toBeUndefined();
    expect(f.sms.sent.length).toBe(sent);
  });
});

describe("OTP verification", () => {
  it("correct code: registers a customer on first login, same user afterwards; code is single-use", async () => {
    const phone = newPhone();
    const a = await otpLogin(f, phone);
    expect(a).toMatchObject({ status: "OK", newUser: true });
    if (a.status !== "OK") return;
    expect(a.session).toMatchObject({ kind: "CUSTOMER", mfaState: "NOT_REQUIRED" });
    const code = f.sms.lastCode(phone)!;
    expect(await f.identity.verifyOtp(phone, code)).toEqual({ status: "INVALID" }); // consumed
    const b = await otpLogin(f, phone);
    expect(b).toMatchObject({ status: "OK", newUser: false });
    if (b.status === "OK") expect(b.session.userId).toBe(a.session.userId);
    const audit = (await f.t.pool.query("select action from audit_logs where entity_id = $1 order by id", [a.session.userId])).rows.map((r) => r.action);
    expect(audit).toEqual(["identity.user.registered"]); // customers: security events only (no per-login row)
  });
  it("wrong code: 5 attempts then LOCKED; the right code no longer works", async () => {
    const phone = newPhone();
    await f.identity.requestOtp(phone);
    const code = f.sms.lastCode(phone)!;
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) expect(await f.identity.verifyOtp(phone, wrong)).toEqual({ status: "INVALID" });
    expect((await challenge(phone)).status).toBe("LOCKED");
    expect(await f.identity.verifyOtp(phone, code)).toEqual({ status: "INVALID" });
  });
  it("expired code is rejected (2 minutes)", async () => {
    const phone = newPhone();
    await f.identity.requestOtp(phone);
    const code = f.sms.lastCode(phone)!;
    f.clock.advance(119_000);
    const ok = await f.identity.verifyOtp(phone, code);
    expect(ok.status).toBe("OK");
    const p2 = newPhone();
    await f.identity.requestOtp(p2);
    const c2 = f.sms.lastCode(p2)!;
    f.clock.advance(121_000);
    expect(await f.identity.verifyOtp(p2, c2)).toEqual({ status: "INVALID" });
  });
  it("accepts Persian digits in phone and code; rejects malformed input as INVALID without touching attempts", async () => {
    const phone = newPhone();
    await f.identity.requestOtp(phone);
    const code = f.sms.lastCode(phone)!;
    expect(await f.identity.verifyOtp(phone, "12ab56")).toEqual({ status: "INVALID" });
    expect((await challenge(phone)).attempts).toBe(0);
    const fa = (s: string) => s.replace(/\d/g, (d) => String.fromCharCode(0x06f0 + Number(d)));
    const r = await f.identity.verifyOtp(fa("0" + phone.slice(3)), fa(code));
    expect(r.status).toBe("OK");
  });
  it("a suspended account cannot log in even with a correct code; the code is burnt", async () => {
    const c = await customer(f);
    await f.t.pool.query("select set_config('app.actor_id','test',false)");
    await f.t.pool.query("update users set status = 'SUSPENDED' where id = $1", [c.actor.userId]);
    expect(await otpLogin(f, c.phone)).toEqual({ status: "INVALID" });
    expect(await f.identity.authenticate(c.token)).toBeNull(); // existing sessions die with the status
  });
  it("limits verification attempts per phone per hour (30)", async () => {
    const phone = newPhone();
    const out: string[] = [];
    for (let i = 0; i < 31; i++) out.push((await f.identity.verifyOtp(phone, "123456")).status);
    expect(out.slice(0, 30).every((s) => s === "INVALID")).toBe(true);
    expect(out[30]).toBe("RATE_LIMITED");
  });
});

describe("sessions", () => {
  it("authenticate returns a light Actor; token is random and only its SHA-256 digest is stored", async () => {
    const c = await customer(f);
    expect(c.actor).toMatchObject({ kind: "CUSTOMER", mfaVerifiedAt: null, stepUpAt: null });
    const rows = (await f.t.pool.query("select * from user_sessions where user_id = $1", [c.actor.userId])).rows;
    expect(JSON.stringify(rows)).not.toContain(c.token);
    expect(rows[0].token_digest.length).toBe(32);
    for (const bad of [undefined, "", "x", "A".repeat(43), c.token.slice(0, -1) + (c.token.endsWith("A") ? "B" : "A")]) expect(await f.identity.authenticate(bad)).toBeNull();
  });
  it("authenticate costs exactly ONE database round trip on the hot path (touch is throttled)", async () => {
    const c = await customer(f);
    let n = 0;
    const counting = new Proxy(f.app.db, { get: (t, p, r) => (p === "execute" ? (...a: unknown[]) => (n++, (t.execute as (...x: unknown[]) => unknown)(...a)) : Reflect.get(t, p, r)) });
    const id = f.make({ db: counting });
    f.clock.advance(10_000);
    expect(await id.authenticate(c.token)).not.toBeNull();
    expect(n).toBe(1);
    n = 0;
    f.clock.advance(61_000);
    expect(await id.authenticate(c.token)).not.toBeNull();
    expect(n).toBe(2); // 1 lookup + 1 throttled touch
  });
  it("customer: 7-day idle expiry slides with activity; 30-day absolute expiry is hard", async () => {
    const c = await customer(f);
    const day = 86_400_000;
    for (let i = 0; i < 4; i++) {
      f.clock.advance(6 * day);
      if (i < 4) expect(await f.identity.authenticate(c.token), `day ${(i + 1) * 6}`).not.toBeNull();
    }
    f.clock.advance(6 * day + 1000); // day 30+: absolute limit reached although never idle for 7 days
    expect(await f.identity.authenticate(c.token)).toBeNull();
    const d = await customer(f);
    f.clock.advance(7 * day + 1000);
    expect(await f.identity.authenticate(d.token)).toBeNull(); // idle
  });
  it("last_seen_at is refreshed at most once per minute", async () => {
    const c = await customer(f);
    const seen = async () => (await f.t.pool.query("select last_seen_at from user_sessions where user_id = $1", [c.actor.userId])).rows[0].last_seen_at.getTime() as number;
    const t0 = await seen();
    f.clock.advance(30_000);
    await f.identity.authenticate(c.token);
    expect(await seen()).toBe(t0);
    f.clock.advance(31_000);
    await f.identity.authenticate(c.token);
    expect(await seen()).toBeGreaterThan(t0);
  });
  it("logout revokes immediately and is idempotent; unknown tokens are a silent no-op", async () => {
    const c = await customer(f);
    await f.identity.logout(c.token);
    expect(await f.identity.authenticate(c.token)).toBeNull();
    await f.identity.logout(c.token);
    await f.identity.logout("garbage");
  });
  it("revokeOwnSessions revokes all (or all but the current one)", async () => {
    const phone = newPhone();
    const a = await customer(f, phone);
    const b = await customer(f, phone);
    const c = await customer(f, phone);
    expect(await f.identity.revokeOwnSessions(c.actor, { keepCurrent: true })).toBe(2);
    expect(await f.identity.authenticate(a.token)).toBeNull();
    expect(await f.identity.authenticate(b.token)).toBeNull();
    expect(await f.identity.authenticate(c.token)).not.toBeNull();
    expect(await f.identity.revokeOwnSessions(c.actor)).toBe(1);
    expect(await f.identity.authenticate(c.token)).toBeNull();
  });
});

describe("database guarantees (application role)", () => {
  it("the app role cannot delete identity rows, rewrite expiry, bump authz_version, or revive a revoked session", async () => {
    const c = await customer(f);
    const q = (s: string, p: unknown[] = []) => f.app.pool.query(s, p).then(() => "ok", (e: unknown) => pgCode(e));
    for (const t of ["users", "user_identities", "otp_challenges", "user_sessions", "roles", "role_permissions", "user_roles", "admin_totp", "admin_recovery_codes", "mfa_recovery_requests", "rate_limit_counters"]) {
      expect(await q(`delete from ${t}`), t).toBe("42501");
    }
    expect(await q("update user_sessions set absolute_expires_at = now() + interval '10 years' where user_id = $1", [c.actor.userId])).toBe("42501");
    expect(await q("update users set authz_version = 99 where id = $1", [c.actor.userId])).toBe("42501");
    expect(await q("update users set kind = 'STAFF' where id = $1", [c.actor.userId])).toBe("42501");
    await f.identity.logout(c.token);
    expect(await q("update user_sessions set revoked_at = null where user_id = $1", [c.actor.userId])).toBe("PI001");
    expect(await q("update user_sessions set last_seen_at = now() where user_id = $1", [c.actor.userId])).toBe("PI001");
  });
  it("only one verifiable challenge per phone and phone format is enforced in the database", async () => {
    const phone = newPhone();
    await f.identity.requestOtp(phone);
    const ins = (p: string, st: string) => f.t.pool.query(`insert into otp_challenges (id, phone, code_digest, hmac_version, status, max_attempts, created_at, expires_at) values (gen_random_uuid(), $1, decode(repeat('ab',32),'hex'), 1, $2, 5, now(), now())`, [p, st]).then(() => "ok", (e: unknown) => pgCode(e));
    expect(await ins(phone, "PENDING")).toBe("23505");
    expect(await ins("+441234567890", "PENDING")).toBe("23514");
  });
});
