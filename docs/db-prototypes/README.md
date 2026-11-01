# SQL prototypes — design-validation material, NOT the application test suite

These scripts validated design ideas against PostgreSQL before any application code existed. They are frozen as a **design regression** (`npm run test:sql-prototypes`, separate CI step).
- Their success does **not** mean the commercial system is correct or ready; they exercise SQL primitives only (no services, no authorisation, no orders, no real flows).
- None of these files is a production migration. Production migrations live in `db/migrations/` and are written/reviewed separately (see `docs/PHASE_2B_PLAN.md`).
- Application tests (`tests/**`, Vitest) are reported separately. When a prototype check gets an application-level equivalent, both counts are reported side by side.
