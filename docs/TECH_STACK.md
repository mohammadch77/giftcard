# TECH_STACK.md

Status: **PROPOSAL.** Repository is empty, so nothing is installed and nothing conflicts. No dependencies have been installed in this phase.

## Recommended stack
| Concern | Choice | Why / note |
|---|---|---|
| Runtime | Node 22 LTS | available locally |
| Framework | Next.js (App Router) + React + strict TypeScript | per brief; one deployable for UI + server |
| Styling | Tailwind CSS + shadcn/ui + Lucide | per brief; shadcn gives `Button`, `cn` util the Bento component expects |
| Fonts | Vazirmatn (fa), Inter (en) — **self-hosted** | avoid Google Fonts at runtime (reliability/latency in Iran) |
| Animation | Framer Motion (`motion`) only where needed | |
| DB | PostgreSQL 16+ | row locks, SKIP LOCKED, deferred constraint triggers, citext |
| Data access | **Decision needed: Prisma vs Drizzle** (see below) | |
| Validation | Zod | |
| Auth | Auth.js *or* small custom server-side session module | depends on login method |
| Password hashing | argon2id (`@node-rs/argon2` or `argon2`) | |
| Crypto | Node built-in `crypto` | AES-256-GCM, HMAC; no extra lib |
| Jobs | Postgres outbox + worker script | no Redis in v1 |
| Rate limit | Postgres/in-process limiter behind an interface | Redis only if multi-instance |
| Dates | Jalali display via `Intl` (`fa-IR-u-ca-persian`) + small helper | avoid heavy libs |
| Tests | Vitest (unit/integration), Playwright (e2e; browser already available), `pg` + real PostgreSQL for DB/concurrency tests | DB tests must run on real Postgres, not mocks |
| Lint/boundaries | ESLint + `dependency-cruiser` | enforce module boundaries |
| Observability | pino JSON logs; error reporter interface (Sentry optional) | |

## Prisma vs Drizzle (needs your decision)
The design depends on CHECK constraints, partial indexes, triggers, deferred constraint triggers and `SELECT … FOR UPDATE SKIP LOCKED`.
- **Prisma:** (preferred in your brief) great DX/types; cannot declare CHECKs/partial indexes/triggers in schema → we hand-write SQL migrations and use `$queryRaw` for the critical paths. Risk: schema file and real DB drift apart (mitigated by CI drift check). `prisma migrate` can carry custom SQL.
- **Drizzle:** SQL-first, supports CHECK + partial indexes natively, transactions with raw SQL are natural, lighter runtime. Triggers still hand-written.
- **Recommendation:** either works; I lean **Drizzle** for a DB-integrity-first project, **Prisma** if team familiarity matters more. Not blocking Phase 1.

## Dependencies: required now vs later
Phase 1: **none installed.**
Phase 2 (core backend), each justified when added: `next react react-dom typescript`, `zod`, `pg` + chosen ORM, `@node-rs/argon2`, `pino`, `vitest`, `dependency-cruiser`.
Phase 4–5 (UI): `tailwindcss`, shadcn CLI-generated components (`class-variance-authority`, `clsx`, `tailwind-merge`, `@radix-ui/*` as needed), `lucide-react`, `motion`, `@radix-ui/react-icons` (only because the Bento reference imports it — see DESIGN_REFERENCES).
Explicitly **not** adding: Redis, BullMQ, Sentry SDK, Docker, GraphQL, state-management libs, CMS — until a concrete need is shown.

## Environment / hosting assumptions (to confirm)
Linux VPS reachable from Iran, PostgreSQL on same host or private network, systemd/PM2, reverse proxy (nginx/caddy) with TLS, daily encrypted backups + WAL archiving, outbound access allowed to the chosen payment gateway and SMS provider. Vercel/serverless is **not** assumed (long-lived worker + DB triggers + domestic gateways).
