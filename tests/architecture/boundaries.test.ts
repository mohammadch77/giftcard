import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import allowed from "../../architecture/module-deps.cjs";

const repo = path.resolve(__dirname, "../..");
const depcruiseBin = path.join(repo, "node_modules/.bin/depcruise");
const config = path.join(repo, ".dependency-cruiser.cjs");
const tmpRoots: string[] = [];

function cruise(files: Record<string, string>): string[] {
  const root = mkdtempSync(path.join(os.tmpdir(), "boundary-"));
  tmpRoots.push(root);
  writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, module: "ESNext", moduleResolution: "Bundler" } }));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return violationsOf(root);
}

function violationsOf(cwd: string): string[] {
  // The json reporter may exit 0 even when violations exist, so always parse the report.
  let out: string;
  try {
    out = execFileSync(depcruiseBin, ["src", "--config", config, "--output-type", "json"], { cwd, stdio: "pipe" }).toString();
  } catch (e) {
    out = (e as { stdout?: Buffer }).stdout?.toString() ?? "";
  }
  const json = JSON.parse(out) as { summary: { violations: { rule: { name: string } }[] } };
  return json.summary.violations.map((v) => v.rule.name);
}


afterAll(() => tmpRoots.forEach((r) => rmSync(r, { recursive: true, force: true })));

describe("module matrix", () => {
  it("covers every module directory and only existing modules", () => {
    const dirs = readdirSync(path.join(repo, "src/modules")).sort();
    expect(Object.keys(allowed).sort()).toEqual(dirs);
    for (const deps of Object.values(allowed) as string[][]) for (const d of deps) expect(dirs).toContain(d);
  });

  it("has no cycles in the allowed matrix", () => {
    const m = allowed as Record<string, string[]>;
    const visiting = new Set<string>();
    const done = new Set<string>();
    const visit = (n: string, trail: string[]) => {
      if (done.has(n)) return;
      if (visiting.has(n)) throw new Error(`cycle: ${[...trail, n].join(" -> ")}`);
      visiting.add(n);
      for (const d of m[n] ?? []) visit(d, [...trail, n]);
      visiting.delete(n);
      done.add(n);
    };
    for (const n of Object.keys(m)) visit(n, []);
  });
});

describe("dependency-cruiser rules actually reject violations", () => {
  it("accepts a legal import through a module's index.ts", () => {
    expect(
      cruise({
        "src/modules/ledger/index.ts": "export const x = 1;",
        "src/modules/wallet/index.ts": "import { x } from '../ledger';\nexport const y = x;",
      }),
    ).toEqual([]);
  });

  it("rejects importing another module's internals", () => {
    const v = cruise({
      "src/modules/ledger/infra/repo.ts": "export const r = 1;",
      "src/modules/wallet/index.ts": "import { r } from '../ledger/infra/repo';\nexport const y = r;",
    });
    expect(v).toContain("no-module-internals-from-other-modules");
  });

  it("rejects a dependency outside the allowed matrix (ledger -> wallet)", () => {
    const v = cruise({
      "src/modules/wallet/index.ts": "export const w = 1;",
      "src/modules/ledger/index.ts": "import { w } from '../wallet';\nexport const l = w;",
    });
    expect(v).toContain("module-dependency-matrix:ledger");
  });

  it("rejects payments -> orders (must use outbox events)", () => {
    const v = cruise({
      "src/modules/orders/index.ts": "export const o = 1;",
      "src/modules/payments/index.ts": "import { o } from '../orders';\nexport const p = o;",
    });
    expect(v).toContain("module-dependency-matrix:payments");
  });

  it("rejects circular imports", () => {
    const v = cruise({
      "src/modules/orders/index.ts": "import { w } from '../wallet';\nexport const o = w;",
      "src/modules/wallet/index.ts": "import { o } from '../orders';\nexport const w = o;",
    });
    expect(v).toContain("no-circular");
  });

  it("rejects app/ importing DB layer and module infra", () => {
    const v = cruise({
      "src/platform/db/index.ts": "export const db = 1;",
      "src/modules/orders/infra/q.ts": "export const q = 1;",
      "src/app/page.ts": "import { db } from '../platform/db';\nimport { q } from '../modules/orders/infra/q';\nexport default [db, q];",
    });
    expect(v).toContain("app-has-no-direct-db-access");
    expect(v).toContain("no-module-internals-from-outside-modules");
  });

  it("rejects platform importing business modules and ui importing modules", () => {
    const v = cruise({
      "src/modules/orders/index.ts": "export const o = 1;",
      "src/platform/x.ts": "import { o } from '../modules/orders';\nexport const x = o;",
      "src/ui/card.ts": "import { o } from '../modules/orders';\nexport const c = o;",
    });
    expect(v).toContain("platform-is-domain-free");
    expect(v).toContain("ui-is-presentational");
  });

  it("the real source tree is clean", () => {
    expect(violationsOf(repo)).toEqual([]);
  });
});
