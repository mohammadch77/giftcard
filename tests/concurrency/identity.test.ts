import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { totp } from "@/modules/identity/domain/totp";
import { consumeRateLimit } from "@/platform/ratelimit";
import { bootstrapOwner, customer, enrolStaff, identityFixture, newPhone, otpLogin, relogin } from "../helpers/identity";
import type { IdentityFixture } from "../helpers/identity";

let f: IdentityFixture;
beforeAll(async () => {
  f = await identityFixture("2026-06-01T10:00:00Z", { otp: { sendsPerHour: 1000, verifiesPerHour: 10000, globalSendsPerHour: 100000 } });
});
afterAll(async () => {
  await f?.app.close();
  await f?.t.drop();
});

const all = <T>(n: number, fn: (i: number) => Promise<T>) => Promise.all(Array.from({ length: n }, (_, i) => fn(i)));

describe("rate limiter", () => {
  it("60 concurrent hits on a limit of 10 admit exactly 10", async () => {
    const res = await all(60, () => consumeRateLimit(f.app.db, { bucket: "t:conc", limit: 10, windowSeconds: 60 }, f.clock));
    expect(res.filter((r) => r.allowed)).toHaveLength(10);
    expect(Math.max(...res.map((r) => r.count))).toBe(60);
    const row = (await f.t.pool.query("select count from rate_limit_counters where bucket = 't:conc'")).rows;
    expect(row).toHaveLength(1);
    expect(Number(row[0].count)).toBe(60);
  });
  it("a new window starts fresh", async () => {
    await consumeRateLimit(f.app.db, { bucket: "t:win", limit: 1, windowSeconds: 10 }, f.clock);
    expect((await consumeRateLimit(f.app.db, { bucket: "t:win", limit: 1, windowSeconds: 10 }, f.clock)).allowed).toBe(false);
    f.clock.advance(10_000);
    expect((await consumeRateLimit(f.app.db, { bucket: "t:win", limit: 1, windowSeconds: 10 }, f.clock)).allowed).toBe(true);
  });
});

describe("OTP", () => {
  it("50 concurrent verifications of the correct code produce exactly ONE session and one registration", async () => {
    const phone = newPhone();
    await f.identity.requestOtp(phone);
    const code = f.sms.lastCode(phone)!;
    const res = await all(50, () => f.identity.verifyOtp(phone, code));
    expect(res.filter((r) => r.status === "OK")).toHaveLength(1);
    expect(res.filter((r) => r.status === "INVALID").length).toBe(49);
    expect((await f.t.pool.query("select count(*)::int c from users u join user_identities i on i.user_id = u.id where i.value = $1", [phone])).rows[0].c).toBe(1);
    expect((await f.t.pool.query("select count(*)::int c from user_sessions s join user_identities i on i.user_id = s.user_id where i.value = $1", [phone])).rows[0].c).toBe(1);
  });
  it("concurrent WRONG guesses can never exceed max attempts, and the code is dead afterwards", async () => {
    const phone = newPhone();
    await f.identity.requestOtp(phone);
    const code = f.sms.lastCode(phone)!;
    const wrong = code === "123456" ? "654321" : "123456";
    await all(40, () => f.identity.verifyOtp(phone, wrong));
    const ch = (await f.t.pool.query("select attempts, status from otp_challenges where phone = $1", [phone])).rows[0];
    expect(ch).toEqual({ attempts: 5, status: "LOCKED" });
    expect(await f.identity.verifyOtp(phone, code)).toEqual({ status: "INVALID" });
  });
  it("concurrent requests for one phone leave exactly one verifiable challenge and send at most one SMS per accepted request", async () => {
    const phone = newPhone();
    const res = await all(15, () => f.identity.requestOtp(phone));
    expect(res.filter((r) => r.status === "SENT").length).toBeGreaterThanOrEqual(1);
    const active = (await f.t.pool.query("select count(*)::int c from otp_challenges where phone = $1 and status in ('PENDING','SENT')", [phone])).rows[0].c;
    expect(active).toBe(1);
    expect(f.sms.sent.filter((m) => m.to === phone).length).toBeLessThanOrEqual(res.filter((r) => r.status === "SENT").length);
  });
});

describe("sessions", () => {
  it("revocation racing with authentication: once logout has returned, no later authenticate succeeds", async () => {
    const c = await customer(f);
    const during = await Promise.all([f.identity.logout(c.token), ...Array.from({ length: 30 }, () => f.identity.authenticate(c.token))]);
    void during;
    const after = await all(20, () => f.identity.authenticate(c.token));
    expect(after.every((a) => a === null)).toBe(true);
  });
  it("logout-everywhere under concurrent logins leaves no session of the pre-revoke set alive", async () => {
    const phone = newPhone();
    const sessions = [await customer(f, phone), await customer(f, phone), await customer(f, phone)];
    const last = sessions[2]!;
    await Promise.all([f.identity.revokeOwnSessions(last.actor), ...sessions.map((s) => f.identity.authenticate(s.token))]);
    for (const s of sessions) expect(await f.identity.authenticate(s.token)).toBeNull();
  });
});

describe("TOTP replay and recovery codes", () => {
  let ownerS: Awaited<ReturnType<typeof enrolStaff>>;
  beforeAll(async () => {
    const phone = newPhone();
    await bootstrapOwner(f, phone);
    ownerS = await enrolStaff(f, phone);
  });
  const restricted = async (n: number) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      const r = await otpLogin(f, ownerS.phone);
      if (r.status !== "OK") throw new Error("login failed");
      out.push((await f.identity.authenticate(r.session.token))!);
    }
    return out;
  };

  it("the same TOTP code submitted concurrently on 10 restricted sessions succeeds exactly once", async () => {
    const actors = await restricted(10);
    f.clock.advance(31_000);
    const code = totp(ownerS.secret!, f.clock.now());
    const res = await Promise.all(actors.map((a) => f.identity.verifyTotp(a, code)));
    expect(res.filter((r) => r.status === "OK")).toHaveLength(1);
    expect(res.filter((r) => r.status === "INVALID")).toHaveLength(9);
  });

  it("one recovery code consumed concurrently from 10 sessions works exactly once", async () => {
    const actors = await restricted(10);
    const code = ownerS.recoveryCodes[0]!;
    const res = await Promise.all(actors.map((a) => f.identity.verifyRecoveryCode(a, code)));
    expect(res.filter((r) => r.status === "OK")).toHaveLength(1);
    expect(res.filter((r) => r.status === "INVALID" || r.status === "RATE_LIMITED")).toHaveLength(9); // 5 attempts per 15 min also apply
    expect((await f.t.pool.query("select count(*)::int c from admin_recovery_codes where user_id = $1 and used_at is not null", [ownerS.userId])).rows[0].c).toBe(1);
  });

  it("concurrent regeneration and use never leaves two live batches", async () => {
    const fresh = await relogin(f, ownerS);
    const [actor] = await restricted(1);
    await Promise.all([f.identity.regenerateRecoveryCodes(fresh.actor), f.identity.regenerateRecoveryCodes(fresh.actor), f.identity.verifyRecoveryCode(actor!, ownerS.recoveryCodes[1]!)]);
    const live = (await f.t.pool.query("select count(distinct batch_id)::int c from admin_recovery_codes where user_id = $1 and used_at is null and superseded_at is null", [ownerS.userId])).rows[0].c;
    expect(live).toBe(1);
    const dup = (await f.t.pool.query("select count(*)::int c from (select code_digest from admin_recovery_codes group by code_digest having count(*) > 1) x")).rows[0].c;
    expect(dup).toBe(0);
  });
});
