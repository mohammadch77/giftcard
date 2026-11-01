import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Schema-drift guard: the Drizzle schema (src/**) must be fully represented by the committed
 * migrations. Runs `drizzle-kit generate`; if it produces anything, the schema has changed
 * without a migration -> remove the generated files and fail.
 */
const dir = path.resolve("db/migrations");

const originals = new Map<string, Buffer>();

function snapshot(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = path.join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else {
        const content = readFileSync(p);
        originals.set(path.relative(dir, p), content);
        out.set(path.relative(dir, p), createHash("sha256").update(content).digest("hex"));
      }
    }
  };
  walk(dir);
  return out;
}

const before = snapshot();
const originalsBefore = new Map(originals);
execFileSync("npx", ["drizzle-kit", "generate", "--name=drift_check"], { stdio: "pipe" });
const after = snapshot();

const changed = [...after.keys()].filter((k) => before.get(k) !== after.get(k));
const removed = [...before.keys()].filter((k) => !after.has(k));
if (changed.length || removed.length) {
  // Undo whatever drizzle-kit generated: delete new files, restore modified ones.
  for (const k of changed) {
    if (!before.has(k)) rmSync(path.join(dir, k));
    else writeFileSync(path.join(dir, k), originalsBefore.get(k)!);
  }
  console.error("SCHEMA DRIFT: Drizzle schema differs from committed migrations.\nChanged/new:", changed.join(", "));
  process.exit(1);
}
console.log("no schema drift");
