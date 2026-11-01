# PHASE_2A_NOTES.md — Foundation scaffold report

Scope executed (authorised 2026-11-01): scaffold, Drizzle, SQL migration workflow, DB test harness, module boundaries, modular-monolith structure, env validation, lint/typecheck/tests. **No business feature, no real provider, no secrets, no UI design.**

## How to run
```bash
cp .env.example .env            # fill local values; .env is gitignored
npm ci
npm run db:migrate              # applies db/migrations to DATABASE_URL (forward-only)
npm run check                   # lint + typecheck + architecture + unit + db tests
npm run db:drift                # fails if the Drizzle schema differs from committed migrations
npm run test:sql-prototypes     # the 40 SQL prototype checks (needs createdb/psql access)
npm run dev | build | start | worker
```

## Verification results (run on 2026-11-01, PostgreSQL 16.15, Node 22.23)
| Check | Result |
|---|---|
| `npm run lint` | clean |
| `npm run typecheck` (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) | clean |
| `npm run arch` (dependency-cruiser, 37 modules / 18 deps) | no violations |
| `npm run test:unit` | 19 passed (9 env validation, 10 architecture) |
| `npm run test:db` | 7 passed (migrations, idempotent re-run, CHECK, append-only guard, tx rollback, SKIP LOCKED x2) |
| `npm run db:drift` | clean; **also verified to fail** when the schema is changed without a migration, and to restore the migration folder exactly |
| `npm run build` (Next 16.4.3) | success; routes `/` (placeholder) and `/api/health` |
| `GET /api/health` via `next start` | `200 {"status":"ok"}`, `Cache-Control: no-store`; `<html lang="fa" dir="rtl">` |
| Worker with invalid env | refuses to start (names variables, never values) |
| `npm run test:sql-prototypes` (the pre-existing 40 checks) | **40 passed, 0 failed** — output in `docs/db-prototypes/LAST_RUN.txt` |

## Defects found and fixed during this phase
1. dependency-cruiser's JSON reporter exits 0 even with violations → boundary tests initially passed vacuously; tests now always parse the report (and prove the rules bite with fixtures).
2. Fixture projects need their own `tsconfig.json` for depcruise.
3. `check-drift.ts` first version restored files via `git` (unavailable before first commit) and left a stale journal entry after a failure; it now restores from in-memory copies, and the stale `0002_drift_check` journal entry it had left behind was removed before committing.
4. Node-postgres needs an explicit user in socket-style URLs (`postgresql://root@/db?host=/var/run/postgresql`) when `$USER` is unset; documented for local `.env`.

## What was created
- **Tooling/config:** `package.json` (pinned deps), `tsconfig.json`, `next.config.ts` (standalone output), `eslint.config.mjs`, `vitest.config.mts`, `drizzle.config.ts`, `.dependency-cruiser.cjs`, `architecture/module-deps.cjs` (+`.d.cts`), `.env.example`, `.gitignore`, `.nvmrc`, `.github/workflows/ci.yml`.
- **Source:** `src/platform/config` (zod env validation), `src/platform/db` (client, `withTransaction`, migration runner, `schema/meta.ts`), `src/modules/<16 modules>/{index.ts,domain,application,infra}` (index exports only `MODULE_NAME`), `src/ui`, `src/worker/index.ts` (empty job registry), `src/app` (layout rtl/fa, neutral placeholder page, `/api/health`).
- **DB:** `db/migrations/0000_baseline_db_meta.sql` (generated: `db_meta` + CHECK), `0001_platform_primitives.sql` (custom: `citext`, `platform_reject_mutation()` append-only guard). Both are re-authored minimal primitives; **none of `docs/db-prototypes/*.sql` was promoted to production migrations.**
- **Scripts:** `scripts/migrate.ts`, `scripts/check-drift.ts`.
- **Tests:** `tests/unit/env.test.ts`, `tests/architecture/boundaries.test.ts`, `tests/db/migrations.test.ts`, `tests/helpers/db.ts` (isolated throwaway database per test file, all migrations applied).

## Enforced rules (machine-checked)
Module matrix (`architecture/module-deps.cjs`, covered by tests incl. no cycles) · other modules import only `index.ts` · `platform` imports no module · `ui` imports no module/DB/config · `app` never imports `platform/db` · no circular imports · `src` must not import `tests`/`scripts` or devDependencies · `process.env` readable only in `src/platform/config` · no interpolated values in `.query(\`...${}\`)` · no `any` · no `console.log` in `src`.

## Items deliberately NOT done
Tailwind/shadcn/fonts/UI (Phase 4–5) · argon2, pino · any provider SDK · `KeyProvider`/crypto (needs D8 first) · business tables/migrations · grants/roles (Phase 2b) · Dockerfile (not required).

## Decisions needing your input / risk notes
1. **TypeScript 6.0.3 instead of npm-latest 7.0.2** — typescript-eslint doesn't support TS ≥6.1 yet. Low risk; revisit later.
2. **`npm audit`: 2 advisories (20 packages flagged by propagation, all moderate, dev-tooling only — see DEPENDENCY_AUDIT.md)** (drizzle-kit's bundled legacy `@esbuild-kit` esbuild dev-server; `minimatch` ReDoS in lint tooling). They affect developer machines/CI only, not the shipped app; npm's suggested "fix" would downgrade drizzle-kit/eslint to ancient majors, so it was not applied. Recommend re-checking when drizzle-kit drops `@esbuild-kit`.
3. Vitest 5 and Vite are pulled in transitively by vitest (no direct vite dependency declared).
4. **Correction (verified 2026-11-01 via GitHub API):** the CI workflow *did* run — run #1 on `a2719c7` completed with `success` (all 12 steps). Open CI work is listed in DEPENDENCY_AUDIT §4.
5. Local `.env` (gitignored, not committed) points at a local socket PostgreSQL; `.env.example` contains placeholders only.
