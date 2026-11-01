# TECH_STACK.md

Status: **v0.3 — Phase 2a installed.** Exact pinned versions (all verified installable on 2026-11-01):

| Package | Version | Note |
|---|---|---|
| next / react / react-dom | 16.4.3 / 19.3.1 / 19.3.1 | App Router, `output: 'standalone'` |
| typescript | **6.0.3** | deliberately NOT 7.0.2 (npm `latest`): typescript-eslint 8.72.1 declares `typescript <6.1.0`. Revisit when tooling supports TS 7 |
| eslint / eslint-config-next / typescript-eslint | 9.39.5 / 16.4.3 / 8.72.1 | eslint 10 not used: Next's plugin set targets ≥9, 9.x is the safe line |
| drizzle-orm / drizzle-kit | 0.45.4 / 0.31.11 | |
| pg / @types/pg | 8.23.1 | node-postgres |
| zod | 4.6.7 | |
| vitest | 5.0.5 | real PostgreSQL for DB tests |
| dependency-cruiser | 18.7.0 | module boundaries |
| tsx | 4.23.15 | scripts / worker |
| @types/node | 22.20.5 | matches Node 22 |

Not installed on purpose: Tailwind, shadcn, Radix, Lucide, Framer Motion (UI phases), argon2 (passwords not primary), pino, any provider SDK. `npm audit` reports 2 moderate **dev-tooling** findings (drizzle-kit's legacy `@esbuild-kit` esbuild dev-server issue; `minimatch` ReDoS in lint tooling); the suggested `--force` fixes are major downgrades and were NOT applied — see PHASE_2A_NOTES.md.

## Recommended stack
| Concern | Choice | Why / note |
|---|---|---|
| Runtime | Node 22 LTS | available locally |
| Framework | Next.js (App Router) + React + strict TypeScript | per brief; one deployable for UI + server |
| Styling | Tailwind CSS + shadcn/ui + Lucide | per brief; shadcn gives `Button`, `cn` util the Bento component expects |
| Fonts | Vazirmatn (fa), Inter (en) — **self-hosted** | avoid Google Fonts at runtime (reliability/latency in Iran) |
| Animation | Framer Motion (`motion`) only where needed | |
| DB | PostgreSQL 16+ | row locks, SKIP LOCKED, deferred constraint triggers, citext |
| Data access | **Drizzle ORM — DECIDED (D2)** | PostgreSQL features (CHECK, triggers, SKIP LOCKED, SQL migrations) must be preserved — see below |
| Validation | Zod | |
| Auth | **Mobile OTP primary — DECIDED (D3).** Small custom OTP + server-side session module (leaning; Auth.js re-evaluated at scaffold) ; email attachable later | SMS provider **not selected** → `SmsProvider` port only |
| Password hashing | argon2id — only if passwords are enabled later (OTP is primary) | |
| Crypto | Node built-in `crypto` | AES-256-GCM, HMAC; no extra lib |
| Jobs | Postgres outbox + worker script | no Redis in v1 |
| Rate limit | Postgres/in-process limiter behind an interface | Redis out of scope for v1 (D7) |
| Dates | Jalali display via `Intl` (`fa-IR-u-ca-persian`) + small helper | avoid heavy libs |
| Tests | Vitest (unit/integration), Playwright (e2e; browser already available), `pg` + real PostgreSQL for DB/concurrency tests | DB tests must run on real Postgres, not mocks |
| Lint/boundaries | ESLint + `dependency-cruiser` | enforce module boundaries |
| Observability | pino JSON logs; error reporter interface (Sentry optional) | |

## Drizzle usage rules (decision D2)
- Drizzle owns typed schema + queries; **SQL stays first-class.** Migrations are plain `.sql` files, reviewed; anything Drizzle cannot express (triggers, trigger functions, deferred constraint triggers, partial/expression indexes, grants, some CHECKs) is a hand-written custom migration.
- Critical statements (`SELECT … FOR UPDATE SKIP LOCKED` reservation, ledger posting, conditional status transitions) are written as parameterised SQL (Drizzle `sql` template or DB functions) inside `db.transaction`; reference implementations: `docs/db-prototypes/*.sql`.
- Verified in Phase 2a (drizzle-orm 0.45.4 / kit 0.31.11): `drizzle-kit generate --custom` produces an empty SQL migration that the migrator applies (`--> statement-breakpoint` separates statements; `$fn$` function bodies work); `check()` is expressible and emitted as a real CHECK; the query builder supports `.for('update', { skipLocked: true })` (tested against PostgreSQL, including a two-transaction skip test); the drift guard `npm run db:drift` fails when the schema changes without a migration. Also verified in 2b-1a: partial and expression indexes (e.g. `coalesce(...)`) and CHECKs are expressible in the Drizzle schema API; grants are handled by the registry in migration 0006. Not yet verified: PG enums.
- Money columns are `bigint` mapped to a branded `Rial` type (bigint-safe; avoid JS `number` above 2^53 — Rial totals stay far below, but the type prevents unit mixups).

## Dependencies: required now vs later
Phase 1: **none installed.**
Phase 2 (core backend), each justified when added: `next react react-dom typescript`, `zod`, `drizzle-orm` + `drizzle-kit` + `pg` (node-postgres), `@node-rs/argon2`, `pino`, `vitest`, `dependency-cruiser`.
Phase 4–5 (UI): `tailwindcss`, shadcn CLI-generated components (`class-variance-authority`, `clsx`, `tailwind-merge`, `@radix-ui/*` as needed), `lucide-react`, `motion`, `@radix-ui/react-icons` (only because the Bento reference imports it — see DESIGN_REFERENCES).
Explicitly **not** adding (decision D7): Redis, BullMQ, Docker; also Sentry SDK, GraphQL, state-management libs, CMS — until a concrete need is shown. No SMS/payment/supplier SDKs until providers are chosen.

## Environment / hosting assumptions (**NOT decided — VPS provider and KEK custody need review and approval**)
Linux VPS reachable from Iran, PostgreSQL on same host or private network, systemd/PM2, reverse proxy (nginx/caddy) with TLS, daily encrypted backups + WAL archiving, outbound access allowed to the chosen payment gateway and SMS provider. Vercel/serverless is **not** assumed (long-lived worker + DB triggers + domestic gateways).
