# DEPENDENCY_AUDIT.md

Audit date: 2026-11-01 · `npm audit` (registry advisory data of that day) · lockfile of commit `a2719c7`. **No dependency was changed by this document.**

## 1. Summary (corrects an earlier imprecise statement)
Earlier reports said "2 moderate findings". Accurate figures: **2 distinct advisories**, which `npm audit` propagates to **20 flagged packages** (all severity *moderate*; 0 high, 0 critical). Every flagged package is a **development tool**; none is in the production runtime bundle (the `next build` standalone output contains only `next`, `react`, `react-dom`, `sharp`, `styled-jsx`, `semver`, … — no `esbuild`, `minimatch`, `drizzle-kit`, `eslint`).

## 2. The two advisories and their dependency paths
| Advisory | Vulnerable range | Where it sits in our tree | Practical exposure |
|---|---|---|---|
| **GHSA-67mh-4wv8-2f99** — esbuild dev server lets any website send requests to it and read the response | `esbuild <= 0.24.2` | `drizzle-kit@0.31.11 → @esbuild-kit/esm-loader@2.6.5 → @esbuild-kit/core-utils@3.3.2 → esbuild@0.18.20` (drizzle-kit also has its own safe `esbuild@0.25.12`; `tsx` and `vite` use safe `0.28.2`) | Only exploitable if someone runs esbuild's **serve** mode. Nothing here does (drizzle-kit uses esbuild to *transform* files). Developer-machine tooling only. |
| **GHSA-g3hv-75wg-m249** — minimatch DoS via glob-parts amplification | `minimatch < 11.0.1` | `minimatch@3.1.5` (eslint, `@eslint/*`, `eslint-plugin-import/react/jsx-a11y` via eslint-config-next) and `minimatch@10.2.6` (`@typescript-eslint/typescript-estree`) | Requires attacker-controlled **glob patterns**; our lint runs on our own config/patterns. CI/dev only. |
The other 18 entries (`@esbuild-kit/*`, `@eslint/*`, `@typescript-eslint/*`, `eslint-plugin-*`, `@next/eslint-plugin-next`, `eslint`, `eslint-config-next`, `typescript-eslint`, `drizzle-kit`) are *propagation* entries: they are listed only because they depend on one of the two packages above.
Latest upstream: `minimatch 11.0.3`, `esbuild 0.28.2`.

## 3. Remediation options (none applied)
| Option | What it does | Verdict |
|---|---|---|
| **A. `npm audit fix --force`** | npm proposes `drizzle-kit@0.18.1`, `eslint@4.0.0`, `eslint-config-next@12.0.4`, `typescript-eslint@8.14.0` | **Rejected** — destructive downgrades across 4–5 major versions; would break the Drizzle workflow, ESLint 9 flat config and Next 16 linting. |
| **B. Accept + monitor** | keep versions; document; re-audit each phase | Safe, zero change. Leaves audit "red". |
| **C. `package.json` `overrides` (non-destructive)** | force the two vulnerable packages to patched versions: `"minimatch": "^11.0.3"` and `"@esbuild-kit/core-utils": { "esbuild": "~0.25.12" }` | **Tested in a scratch copy (/tmp, repo untouched): `npm audit` → 0 vulnerabilities; `eslint .` exit 0; `tsc --noEmit` exit 0; `drizzle-kit generate` → "No schema changes".** Not yet tested in the repo's full suite (unit/db/arch/build/CI). Risk: overriding a transitive major (minimatch 3→11) is unsupported by the packages that depend on it; it may break on a future eslint/plugin update. |
| **D. Wait for upstream** | drizzle-kit `1.0.0-rc.5` no longer depends on `@esbuild-kit/*` (esbuild `^0.25.10`), but it is a **release candidate paired with drizzle-orm 1.0** | Not recommended for a financial system until stable. |

**Recommendation:** C (only if you approve a `package.json` change) with the full suite + CI re-run as its acceptance test, plus a recorded note to **remove the overrides when eslint/typescript-eslint/drizzle-kit ship patched dependencies**; otherwise B. Either way: add an `npm audit --omit=dev` step to CI (production dependencies are currently clean: audit of the runtime tree reports nothing) and treat any *production-dependency* advisory as blocking, dev-only advisories as tracked.

## 4. CI status (GitHub Actions) — actual
Checked through the GitHub API on 2026-11-01:
- Workflow `ci` (`.github/workflows/ci.yml`) is **active**.
- **Run #1** (event `push`, branch `claude/gaming-store-architecture-m95hp0`, commit `a2719c7`) **completed with conclusion `success`** in ~2.5 min. All 12 steps succeeded: `npm ci`, lint, typecheck, arch, test:unit, test:db, db:drift, test:sql-prototypes.
- It ran against a throw-away `postgres:16` service container with a dummy password that exists only in the workflow file.
- Only one run exists; there is no history yet.

**Open CI work (recorded, not done):** (1) enable branch protection / required status check on the default branch; (2) pin `actions/checkout`, `actions/setup-node` by commit SHA; (3) add `npm audit --omit=dev` (fail) and `npm audit` (report) steps; (4) re-run CI after any dependency change; (5) run CI on pull requests to the default branch (currently triggers on every push and PR); (6) keep prototype and application test steps separate (they are).

## 5. Other dependency notes
- `typescript@6.0.3` (not the npm-latest 7.0.2) because `typescript-eslint@8.72.1` supports `<6.1.0`.
- `eslint@9.39.5` (not 10) for `eslint-config-next@16.4.3` compatibility.
- Two packages show as `extraneous` in `npm ls` (`@emnapi/runtime`, `@img/sharp-wasm32`): optional platform binaries of `sharp`; harmless.
- Licence review of the dependency set has not been done (open item before launch).
