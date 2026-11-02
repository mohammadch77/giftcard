CREATE TABLE "audit_logs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_logs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"request_id" text,
	"before" jsonb,
	"after" jsonb,
	"metadata" jsonb,
	CONSTRAINT "audit_logs_actor_type" CHECK ("audit_logs"."actor_type" IN ('USER','ADMIN','SYSTEM','WORKER')),
	CONSTRAINT "audit_logs_action_format" CHECK ("audit_logs"."action" ~ '^[a-z][a-z0-9_.]{1,79}$'),
	CONSTRAINT "audit_logs_entity_type_format" CHECK ("audit_logs"."entity_type" ~ '^[a-z][a-z0-9_]{1,63}$'),
	CONSTRAINT "audit_logs_ids_nonempty" CHECK (length("audit_logs"."actor_id") BETWEEN 1 AND 200 AND length("audit_logs"."entity_id") BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE TABLE "ledger_account_balances" (
	"account_id" bigint PRIMARY KEY NOT NULL,
	"balance" "rial_balance" DEFAULT 0 NOT NULL,
	"min_balance" "rial_balance",
	"entry_count" bigint DEFAULT 0 NOT NULL,
	"last_entry_id" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "ledger_account_balances_floor" CHECK ("ledger_account_balances"."min_balance" IS NULL OR "ledger_account_balances"."balance" >= "ledger_account_balances"."min_balance")
);
--> statement-breakpoint
CREATE TABLE "ledger_accounts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ledger_accounts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"code" text NOT NULL,
	"owner_type" text,
	"owner_id" text,
	"type" text NOT NULL,
	"contra" boolean DEFAULT false NOT NULL,
	"normal_side" text NOT NULL,
	"currency" char(3) DEFAULT 'IRR' NOT NULL,
	"min_balance" "rial_balance",
	"chart_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_accounts_code_format" CHECK ("ledger_accounts"."code" ~ '^[A-Z][A-Z0-9_]{1,63}$'),
	CONSTRAINT "ledger_accounts_type" CHECK ("ledger_accounts"."type" IN ('ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE')),
	CONSTRAINT "ledger_accounts_side" CHECK ("ledger_accounts"."normal_side" IN ('DEBIT','CREDIT')),
	CONSTRAINT "ledger_accounts_currency" CHECK ("ledger_accounts"."currency" = 'IRR'),
	CONSTRAINT "ledger_accounts_owner_pair" CHECK (("ledger_accounts"."owner_type" IS NULL) = ("ledger_accounts"."owner_id" IS NULL)),
	CONSTRAINT "ledger_accounts_normal_side_matches_type" CHECK ("ledger_accounts"."normal_side" = CASE WHEN ("ledger_accounts"."type" IN ('ASSET','EXPENSE')) <> "ledger_accounts"."contra" THEN 'DEBIT' ELSE 'CREDIT' END)
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ledger_entries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"transaction_id" bigint NOT NULL,
	"account_id" bigint NOT NULL,
	"side" text NOT NULL,
	"amount" "rial_amount" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_side" CHECK ("ledger_entries"."side" IN ('DEBIT','CREDIT')),
	CONSTRAINT "ledger_entries_amount_positive" CHECK ("ledger_entries"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "ledger_transactions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ledger_transactions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"reference_type" text NOT NULL,
	"reference_id" text NOT NULL,
	"reverses_id" bigint,
	"description" text,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"audit_log_id" bigint NOT NULL,
	"pg_txid" bigint DEFAULT txid_current() NOT NULL,
	"posted_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_transactions_kind_format" CHECK ("ledger_transactions"."kind" ~ '^[A-Z][A-Z0-9_]{1,63}$'),
	CONSTRAINT "ledger_transactions_key_format" CHECK ("ledger_transactions"."idempotency_key" ~ '^[A-Za-z0-9_.:-]{8,128}$'),
	CONSTRAINT "ledger_transactions_hash_format" CHECK ("ledger_transactions"."request_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "ledger_transactions_ref_format" CHECK ("ledger_transactions"."reference_type" ~ '^[a-z][a-z0-9_]{1,63}$' AND length("ledger_transactions"."reference_id") BETWEEN 1 AND 200),
	CONSTRAINT "ledger_transactions_reversal_consistent" CHECK (("ledger_transactions"."kind" = 'REVERSAL') = ("ledger_transactions"."reverses_id" IS NOT NULL)),
	CONSTRAINT "ledger_transactions_actor_type" CHECK ("ledger_transactions"."actor_type" IN ('USER','ADMIN','SYSTEM','WORKER')),
	CONSTRAINT "ledger_transactions_description_len" CHECK ("ledger_transactions"."description" IS NULL OR length("ledger_transactions"."description") <= 500)
);
--> statement-breakpoint
CREATE INDEX "audit_logs_entity" ON "audit_logs" USING btree ("entity_type","entity_id","id");--> statement-breakpoint
CREATE INDEX "audit_logs_actor" ON "audit_logs" USING btree ("actor_type","actor_id","id");--> statement-breakpoint
CREATE INDEX "audit_logs_action" ON "audit_logs" USING btree ("action","id");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_accounts_identity" ON "ledger_accounts" USING btree ("code",coalesce("owner_type", ''),coalesce("owner_id", ''));--> statement-breakpoint
CREATE INDEX "ledger_accounts_owner" ON "ledger_accounts" USING btree ("owner_type","owner_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_account" ON "ledger_entries" USING btree ("account_id","id");--> statement-breakpoint
CREATE INDEX "ledger_entries_transaction" ON "ledger_entries" USING btree ("transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_transactions_idempotency_key" ON "ledger_transactions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_transactions_one_reversal" ON "ledger_transactions" USING btree ("reverses_id") WHERE "ledger_transactions"."reverses_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ledger_transactions_reference" ON "ledger_transactions" USING btree ("reference_type","reference_id");