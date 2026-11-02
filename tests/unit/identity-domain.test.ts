import { describe, expect, it } from "vitest";
import { PermissionCatalog, IDENTITY_PERMISSIONS, SYSTEM_ROLES, maskPhone, normalizePhone, tryNormalizePhone } from "@/modules/identity";
import { base32Decode, base32Encode, generateTotpSecret, hotp, otpauthUri, totp, verifyTotp } from "@/modules/identity/domain/totp";
import { generateOtpCode, generateRecoveryCode, generateSessionToken, isWellFormedSessionToken, normalizeRecoveryCode, sessionTokenDigest } from "@/modules/identity/domain/tokens";
import { createSmsProvider } from "@/platform/composition";
import { NullSmsProvider } from "@/platform/sms";
import { TestSmsProvider } from "@/platform/sms/testing/test-sms";

describe("Iranian mobile normalisation", () => {
  it.each(["09123456789", "9123456789", "989123456789", "+989123456789", "00989123456789", "۰۹۱۲۳۴۵۶۷۸۹", "0912 345 6789", "0912-345-6789", "(+98) 912 345 6789"])("accepts %s", (raw) => {
    expect(normalizePhone(raw)).toBe("+989123456789");
  });
  it.each(["", "0912345678", "091234567890", "+441234567890", "02112345678", "0812345678901", "abc", "+98912345678a", "9123456789012345678901234567890123456789012"])("rejects %j", (raw) => {
    expect(tryNormalizePhone(raw)).toBeNull();
    expect(() => normalizePhone(raw)).toThrow(expect.objectContaining({ code: "PHONE_INVALID" }));
  });
  it("masks the middle for support views", () => expect(maskPhone("+989123456789")).toBe("+98912***6789"));
});

describe("TOTP (RFC 6238 / RFC 4226 / RFC 4648)", () => {
  const sha1 = Buffer.from("12345678901234567890");
  const sha256 = Buffer.from("12345678901234567890123456789012");
  const sha512 = Buffer.from("1234567890123456789012345678901234567890123456789012345678901234");
  const at = (s: number) => new Date(s * 1000);
  it("RFC 6238 Appendix B vectors (8 digits, SHA-1/256/512)", () => {
    const cases: [number, string, string, string][] = [
      [59, "94287082", "46119246", "90693936"],
      [1111111109, "07081804", "68084774", "25091201"],
      [1111111111, "14050471", "67062674", "99943326"],
      [1234567890, "89005924", "91819424", "93441116"],
      [2000000000, "69279037", "90698825", "38618901"],
      [20000000000, "65353130", "77737706", "47863826"],
    ];
    for (const [t, a, b, c] of cases) {
      expect(totp(sha1, at(t), { digits: 8, algorithm: "sha1" })).toBe(a);
      expect(totp(sha256, at(t), { digits: 8, algorithm: "sha256" })).toBe(b);
      expect(totp(sha512, at(t), { digits: 8, algorithm: "sha512" })).toBe(c);
    }
  });
  it("RFC 4226 Appendix D HOTP vectors", () => {
    const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
    expected.forEach((e, i) => expect(hotp(sha1, i)).toBe(e));
  });
  it("accepts ±1 step, rejects ±2 steps, wrong length and non-digits; returns the matched step", () => {
    const t = at(1_700_000_000);
    const now = totp(sha1, t);
    const step = Math.floor(1_700_000_000 / 30);
    expect(verifyTotp(sha1, now, t)).toBe(step);
    expect(verifyTotp(sha1, now, at(1_700_000_000 + 30))).toBe(step);
    expect(verifyTotp(sha1, now, at(1_700_000_000 + 60))).toBeNull();
    expect(verifyTotp(sha1, now, at(1_700_000_000 - 90))).toBeNull();
    expect(verifyTotp(sha1, "12345", t)).toBeNull();
    expect(verifyTotp(sha1, "12345a", t)).toBeNull();
  });
  it("base32 RFC 4648 vectors and round trip; secrets are 160-bit random", () => {
    for (const [plain, enc] of [["f", "MY"], ["fo", "MZXQ"], ["foo", "MZXW6"], ["foob", "MZXW6YQ"], ["fooba", "MZXW6YTB"], ["foobar", "MZXW6YTBOI"]] as const) {
      expect(base32Encode(Buffer.from(plain))).toBe(enc);
      expect(base32Decode(enc).toString()).toBe(plain);
    }
    expect(base32Decode("mzxw 6ytb-oi==").toString()).toBe("foobar");
    expect(() => base32Decode("1!")).toThrow();
    const a = generateTotpSecret(), b = generateTotpSecret();
    expect(a.length).toBe(20);
    expect(a.equals(b)).toBe(false);
    expect(otpauthUri({ issuer: "Gift Card", account: "u1", secretBase32: "ABC" })).toBe("otpauth://totp/Gift%20Card:u1?secret=ABC&issuer=Gift%20Card&algorithm=SHA1&digits=6&period=30");
  });
});

describe("tokens and codes", () => {
  it("session tokens are 256-bit, unique, base64url; digest is deterministic SHA-256 and never the token", () => {
    const t = generateSessionToken();
    expect(isWellFormedSessionToken(t)).toBe(true);
    expect(t).not.toBe(generateSessionToken());
    expect(sessionTokenDigest(t).length).toBe(32);
    expect(sessionTokenDigest(t).equals(sessionTokenDigest(t))).toBe(true);
    expect(sessionTokenDigest(t).toString("base64url")).not.toBe(t);
    for (const bad of [undefined, null, 5, "", "short", `${t}x`, t.slice(1) + "!"]) expect(isWellFormedSessionToken(bad)).toBe(false);
  });
  it("OTP codes are 6 digits, uniformly spread over the range (no obvious bias)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const c = generateOtpCode();
      expect(c).toMatch(/^\d{6}$/);
      seen.add(c[0]!);
    }
    expect(seen.size).toBe(10);
  });
  it("recovery codes: 80 bits, grouped, unambiguous alphabet, normalisation tolerant, tamper-intolerant", () => {
    const c = generateRecoveryCode();
    expect(c).toMatch(/^([A-HJ-NP-Z2-9]{4}-){3}[A-HJ-NP-Z2-9]{4}$/);
    expect(normalizeRecoveryCode(c.toLowerCase().replace(/-/g, " "))).toBe(c.replace(/-/g, ""));
    expect(normalizeRecoveryCode("0000-0000-0000-0000")).toBeNull();
    expect(normalizeRecoveryCode(c.slice(0, -1))).toBeNull();
    expect(new Set(Array.from({ length: 200 }, generateRecoveryCode)).size).toBe(200);
  });
});

describe("permission catalog and system roles", () => {
  it("rejects malformed keys and conflicting re-registration; has no wildcard", () => {
    const c = new PermissionCatalog();
    expect(() => c.register([{ key: "Bad.Key", description: "x", sensitive: false }])).toThrow();
    expect(() => c.register([{ key: "nodots", description: "x", sensitive: false }])).toThrow();
    expect(() => c.register([{ key: "identity.*", description: "x", sensitive: false }])).toThrow();
    expect(() => c.register([{ key: "identity.users.read", description: "x", sensitive: true }])).toThrow(); // conflicting sensitivity
    c.register([{ key: "ledger.entries.read", description: "owned by the ledger module", sensitive: false }]);
    expect(c.has("ledger.entries.read")).toBe(true);
  });
  it("identity defines only identity.* permissions (financial modules own theirs); system roles reference only registered keys", () => {
    expect(IDENTITY_PERMISSIONS.every((p) => p.key.startsWith("identity."))).toBe(true);
    const cat = new PermissionCatalog();
    for (const [name, r] of Object.entries(SYSTEM_ROLES)) for (const p of r.permissions) expect(cat.has(p), `${name} -> ${p}`).toBe(true);
    expect(Object.keys(SYSTEM_ROLES).sort()).toEqual(["owner", "security_admin", "support_agent"]);
    expect(SYSTEM_ROLES.support_agent!.permissions).toEqual(["identity.users.read"]);
    expect(SYSTEM_ROLES.owner!.permissions.slice().sort()).toEqual(IDENTITY_PERMISSIONS.map((p) => p.key).sort());
  });
});

describe("SMS provider factory (guarded)", () => {
  it("none -> fail-closed provider; test -> double outside production; test double REFUSED in production", async () => {
    expect(createSmsProvider({ NODE_ENV: "development", SMS_PROVIDER: "none" })).toBeInstanceOf(NullSmsProvider);
    await expect(createSmsProvider({ NODE_ENV: "production", SMS_PROVIDER: "none" }).send({ to: "+989123456789", text: "x" })).rejects.toMatchObject({ code: "SMS_PROVIDER_NOT_CONFIGURED" });
    expect(createSmsProvider({ NODE_ENV: "test", SMS_PROVIDER: "test" })).toBeInstanceOf(TestSmsProvider);
    expect(() => createSmsProvider({ NODE_ENV: "production", SMS_PROVIDER: "test" })).toThrow(expect.objectContaining({ code: "SMS_PROVIDER_FORBIDDEN" }));
  });
});
