import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import allowed from "../../architecture/module-deps.cjs";
import * as audit from "@/modules/audit";
import * as ledger from "@/modules/ledger";
import * as crypto from "@/platform/crypto";
import * as db from "@/platform/db";
import * as errors from "@/platform/errors";
import * as idempotency from "@/platform/idempotency";
import * as ids from "@/platform/ids";
import * as money from "@/platform/money";
import * as outbox from "@/platform/outbox";
import * as transitions from "@/platform/transitions";

/**
 * Regression guards for Phase 2b-3 ("no unintended change in unrelated modules"):
 *  1. applied migrations 0000–0011 are byte-for-byte unchanged (hashes taken from the committed 2b-2 state);
 *  2. public runtime exports of audit, ledger and platform/* are a superset of the 2b-2 contract (additions allowed, removals fail);
 *  3. identity tables are private: no other module / platform code mentions them;
 *  4. the module dependency matrix did not gain edges for identity.
 */
const repo = path.resolve(__dirname, "../..");
const APPLIED: Record<string, string> = {
  "0000_baseline_db_meta.sql": "e702d9247e48393303ccb4d81544f0a34c441269850abcf20949c79e07bbf183",
  "0001_platform_primitives.sql": "82348b8dad1d262823804045ef06b76632e272b627beefac821f7c12ffc20993",
  "0002_platform_tables.sql": "fb9f12d488953c069eeeed1f2f25349b7964c92f44992d2b320c813060e26fcc",
  "0003_money_domains.sql": "859e15ec632927073de01f0a0b02e78ea035c0aa9f9175248e1e117aeceae352",
  "0004_transition_engine.sql": "bd58d6b4d8d61bdc339d02416086682fe5baacb7c5155d0f4deebd50a2f1d4a3",
  "0005_idempotency_outbox_logic.sql": "610fa80438c1b686652017efe30bfd305f78a6b551de6edcd41eec409bb716a5",
  "0006_grants_registry.sql": "b2f2243e4d0bd10870f3a052531e25c5b40f1f5bf729e7901f3e3d27358d9431",
  "0007_audit_ledger_tables.sql": "427d3f3610e93a5a8a921a43e6da772fa5240594b934eeb93e670e252cce93de",
  "0008_audit_guards.sql": "89d6c2e5a6caeda865c202c51b34abc6ca311f953940816deca8202c10c6bed4",
  "0009_ledger_guards.sql": "76bf8b47ff442f9f57ce4c0a8e3e2f2a6e8a1142527c15f612408970664a7c56",
  "0010_identity_tables.sql": "1786615fe63bf9ab44cb20d0e542fea9bf13d26080f2d074f3ef0c0afba0593c",
  "0011_identity_guards.sql": "889ccd5ae52363de49e1e8d190b64d1e52c9c9bd2ecb42e7e0d6e1c37859e5e4",
  "0012_catalog_tables.sql": "ee0d547eed8e78bc4a31250ea07fdef39a048a40c1f5ea82d8b517dc7e7dd13b",
  "0013_catalog_guards.sql": "f32b1698ffd24e2fe19ee860ae6b65278590e01ddc863a1ae905416eddc3bb7d",
  "0014_inventory_tables.sql": "4f16cf754789d4d7bfee1de44216786e0f7c7b22836d1f0524e1accf860925f6",
  "0015_inventory_guards.sql": "d3153387ebce321a43ba881747b45ab8a27b50e9a2602240dd307a8a081b5d5e",
};

describe("applied migrations are immutable", () => {
  for (const [file, sha] of Object.entries(APPLIED)) {
    it(file, () => expect(createHash("sha256").update(readFileSync(path.join(repo, "db/migrations", file))).digest("hex")).toBe(sha));
  }
  it("numbering is contiguous", () => {
    const files = readdirSync(path.join(repo, "db/migrations")).filter((f) => f.endsWith(".sql")).sort();
    files.forEach((f, i) => expect(f.startsWith(String(i).padStart(4, "0"))).toBe(true));
  });
});

describe("existing public contracts are preserved (additions only)", () => {
  const baseline: Record<string, string[]> = {"audit":["MODULE_NAME","listAudit","recordAudit"],"ledger":["CHART","CHART_VERSION","MODULE_NAME","POSTING_RULES","SENSITIVE_KINDS","adminWalletCredit","adminWalletDebit","chartEntry","ensureAccount","gatewayReceivable","getBalance","getTransaction","normalSideOf","post","reverse","suspenseReceipt","suspenseToWallet","systemAccount","trialBalance","verifyIntegrity","walletAccount","walletTopUp"]}
  Object.assign(baseline, {
    idempotency: ["canonicalJson", "hashRequest", "withIdempotency"],
    outbox: ["claimOutbox", "enqueueOutbox", "idempotentHandler", "runOutboxOnce"],
    crypto: ["DEK_BYTES", "KEY_BYTES", "NullKeyProvider", "SEALED_FORMAT", "decodeSealed", "digestsEqual", "encodeSealed", "fingerprint", "fingerprintsAllVersions", "normalizeCode", "openSecret", "rewrapSecret", "sealSecret", "secretAad", "withSecret"],
    transitions: ["conditionalTransition", "setTransitionContext"],
    ids: ["ORDER_NUMBER_PATTERN", "generateOrderNumber", "isUuid", "uuidv7", "uuidv7Timestamp"],
    errors: ["DomainError", "isDomainError"],
    db: ["MIGRATIONS_FOLDER", "createDatabase", "runMigrations", "withTransaction"],
    money: ["MAX_RIAL_AGGREGATE", "MAX_RIAL_AMOUNT", "ZERO_RIAL", "addRial", "basisPointsFloor", "compareRial", "floorToToman", "formatToman", "isMultipleOfTen", "mulDivFloor", "mulRial", "percentFloor", "rial", "rialAggregate", "rialPrice", "rialToToman", "subRial", "sumRial", "tomanToRial"],
  });
  const actual: Record<string, object> = { audit, ledger, idempotency, outbox, crypto, transitions, ids, errors, db, money };
  for (const [name, exp] of Object.entries(baseline)) {
    it(name, () => {
      const keys = Object.keys(actual[name]!);
      expect(exp.filter((k) => !keys.includes(k)), `removed exports in ${name}`).toEqual([]);
    });
  }
});

describe("identity data ownership", () => {
  const TABLES = /\b(user_identities|otp_challenges|user_sessions|admin_totp|admin_recovery_codes|mfa_recovery_requests|mfa_recovery_history|user_roles|role_permissions|user_status_history)\b|\b(from|join|into|update)\s+(users|roles)\b/i;
  const walk = (d: string, out: string[] = []): string[] => {
    for (const n of readdirSync(d)) {
      const p = path.join(d, n);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(n)) out.push(p);
    }
    return out;
  };
  it("no source file outside src/modules/identity (and platform schema/ratelimit) references identity tables", () => {
    const offenders = walk(path.join(repo, "src")).filter((p) => !p.includes(`${path.sep}modules${path.sep}identity${path.sep}`)).filter((p) => TABLES.test(readFileSync(p, "utf8")));
    expect(offenders.map((p) => path.relative(repo, p))).toEqual([]);
  });
  it("the dependency matrix still lets identity import only audit, and the ledger does not import identity", () => {
    expect(allowed.identity).toEqual(["audit"]);
    expect(allowed.ledger).toEqual(["audit"]);
    expect(allowed.audit).toEqual([]);
    const importers = Object.entries(allowed as Record<string, string[]>).filter(([, deps]) => deps.includes("identity")).map(([m]) => m).sort();
    expect(importers).toEqual(["fraud", "notifications", "orders", "support"]);
  });
  it("authorisation checks are centralised: nothing outside identity reads sessions or role data", () => {
    const sensitive = walk(path.join(repo, "src")).filter((p) => !p.includes(`${path.sep}modules${path.sep}identity${path.sep}`) && /mfa_verified_at|step_up_at|authz_version/.test(readFileSync(p, "utf8")));
    expect(sensitive).toEqual([]);
  });
});
