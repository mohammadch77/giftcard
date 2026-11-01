# DECISIONS.md

Authoritative log of decisions made by the project owner. Other docs must agree with this file; if they do not, this file wins and the other doc is a bug.

## Final decisions (received after the Phase 0/1 report)
| ID | Decision | Applied in |
|---|---|---|
| D1 | **Money:** all amounts stored as integer **Rial**; UI shows **Toman**; conversion only in dedicated layers (`platform/money`, UI formatting, input boundary). | DATABASE_DESIGN §1, §4, §9; ARCHITECTURE §5a |
| D2 | **ORM: Drizzle.** CHECK, triggers, `SKIP LOCKED` and SQL migrations are preserved. | TECH_STACK; DATABASE_DESIGN §18 |
| D3 | **Auth:** mobile OTP primary for register/login. Email attachable later (architecture reserves it). SMS provider **not selected**. | DATABASE_DESIGN §3; SECURITY §3; ARCHITECTURE §7 |
| D4 | **Payments:** gateway **not selected**. Payment Adapter designed; no hypothetical gateway/API implemented. | DATABASE_DESIGN §11; ARCHITECTURE §6 |
| D5 | **Fulfillment scope v1:** store's manual stock, automatic code delivery, manual delivery of accounts/subscriptions, and Supplier API *architecture* — all in v1. Real supplier connection waits for authoritative documentation. | DATABASE_DESIGN §5, §10, §12; ARCHITECTURE §6 |
| D6 | **No split payment** in v1: wallet **or** gateway. | DATABASE_DESIGN §7; ARCHITECTURE §5b |
| D7 | **No Docker, no Redis** for now. PostgreSQL + outbox. Final VPS and KEK custody **need review and approval**. | ARCHITECTURE §2; SECURITY §2.1 |

## Directives requiring careful design (policy principles fixed, details still open)
| # | Directive | Where designed | Still open |
|---|---|---|---|
| 8 | Late payment / reservation expiry: never deliver without re-reservation; order enters review and settlement. | DATABASE_DESIGN §5.5, STATE_MACHINES | auto re-reserve flag (default off), grace window, hold SLA |
| 9 | Refund policy records delivery and reveal of confidential data; final rules need business + legal decision. | DATABASE_DESIGN §10.1–10.2 | the actual refund rules |
| 10 | Chart of Accounts proposed; revenue-recognition timing **not final** without an accountant. | DATABASE_DESIGN §9.2–9.3 | accountant sign-off (recognition mode, VAT, COGS) |

## Process directives
11–14: fix test script typing issue, re-run all prototypes/tests and report separately; reconcile design-reference status; align docs; **no scaffold/implementation yet.** Results: `db-prototypes/LAST_RUN.txt`, `DESIGN_REFERENCES.md`.
