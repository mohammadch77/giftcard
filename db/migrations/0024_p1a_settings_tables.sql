CREATE TABLE "order_settings_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"reservation_ttl_seconds" integer NOT NULL,
	"source" text NOT NULL,
	"previous_version" integer,
	"changed_by" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "order_settings_ttl_bounds" CHECK ("order_settings_versions"."reservation_ttl_seconds" between 60 and 3600),
	CONSTRAINT "order_settings_source" CHECK ("order_settings_versions"."source" in ('SEED','ADMIN')),
	CONSTRAINT "order_settings_reason" CHECK (char_length(btrim("order_settings_versions"."reason")) >= 10),
	CONSTRAINT "order_settings_chain" CHECK (("order_settings_versions"."version" = 1 and "order_settings_versions"."previous_version" is null) or ("order_settings_versions"."version" > 1 and "order_settings_versions"."previous_version" = "order_settings_versions"."version" - 1))
);
--> statement-breakpoint
CREATE TABLE "wallet_limit_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"min_rial" "rial_amount" NOT NULL,
	"max_rial" "rial_amount" NOT NULL,
	"daily_max_rial" "rial_amount" NOT NULL,
	"source" text NOT NULL,
	"status" text NOT NULL,
	"base_seq" integer,
	"approved_seq" integer,
	"requested_by" text NOT NULL,
	"reason" text NOT NULL,
	"decided_by" text,
	"decision_reason" text,
	"created_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "wallet_limit_status" CHECK ("wallet_limit_versions"."status" in ('REQUESTED','APPROVED','REJECTED')),
	CONSTRAINT "wallet_limit_source" CHECK ("wallet_limit_versions"."source" in ('SEED','ADMIN')),
	CONSTRAINT "wallet_limit_bounds" CHECK ("wallet_limit_versions"."min_rial" >= 10 and "wallet_limit_versions"."min_rial" % 10 = 0 and "wallet_limit_versions"."max_rial" % 10 = 0 and "wallet_limit_versions"."daily_max_rial" % 10 = 0 and "wallet_limit_versions"."max_rial" <= 1000000000000 and "wallet_limit_versions"."daily_max_rial" <= 10000000000000),
	CONSTRAINT "wallet_limit_order" CHECK ("wallet_limit_versions"."min_rial" <= "wallet_limit_versions"."max_rial" and "wallet_limit_versions"."max_rial" <= "wallet_limit_versions"."daily_max_rial"),
	CONSTRAINT "wallet_limit_reason" CHECK (char_length(btrim("wallet_limit_versions"."reason")) >= 10),
	CONSTRAINT "wallet_limit_decision" CHECK (("wallet_limit_versions"."status" = 'REQUESTED' and "wallet_limit_versions"."decided_by" is null and "wallet_limit_versions"."decided_at" is null and "wallet_limit_versions"."approved_seq" is null)
        or ("wallet_limit_versions"."status" = 'APPROVED' and "wallet_limit_versions"."decided_by" is not null and "wallet_limit_versions"."decided_at" is not null and "wallet_limit_versions"."approved_seq" is not null and "wallet_limit_versions"."decided_by" <> "wallet_limit_versions"."requested_by" and char_length(btrim(coalesce("wallet_limit_versions"."decision_reason", ''))) >= 5)
        or ("wallet_limit_versions"."status" = 'REJECTED' and "wallet_limit_versions"."decided_by" is not null and "wallet_limit_versions"."decided_at" is not null and "wallet_limit_versions"."approved_seq" is null and "wallet_limit_versions"."decided_by" <> "wallet_limit_versions"."requested_by" and char_length(btrim(coalesce("wallet_limit_versions"."decision_reason", ''))) >= 5))
);
--> statement-breakpoint
-- P1-A order-time policy snapshots. The columns are added NULLABLE, EXISTING orders are backfilled from facts that are already recorded
-- (never invented, never silently rewritten: the snapshot is flagged "backfilled"), and only then are the columns made NOT NULL.
-- Hand-edited from the generated statement on purpose: a plain ADD COLUMN ... NOT NULL cannot be applied to a populated table.
ALTER TABLE "orders" ADD COLUMN "refund_policy_version" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "policy_snapshot" jsonb;--> statement-breakpoint
-- Backfill strategy: before this migration exactly ONE refund policy version has ever existed ('temporary-0', migration 0023), so every
-- earlier order was necessarily created under it. The reservation TTL is what the order really used (expires_at - created_at, both immutable).
-- Fulfilment methods come from the order's own immutable item snapshots. Settings version / compatibility rules did not exist => null.
UPDATE "orders" o SET
  "refund_policy_version" = 'temporary-0',
  "policy_snapshot" = jsonb_build_object(
    'schema', 1,
    'backfilled', true,
    'backfilledBy', '0024_p1a_settings_tables',
    'refundPolicyVersion', 'temporary-0',
    'reservationTtlSeconds', round(extract(epoch from (o.expires_at - o.created_at)))::int,
    'orderSettingsVersion', null,
    'fulfillmentRules', null,
    'itemFulfillmentMethods', (SELECT coalesce(jsonb_agg(DISTINCT i.snapshot ->> 'fulfillmentMethod'), '[]'::jsonb) FROM "order_items" i WHERE i.order_id = o.id)
  )
WHERE o."refund_policy_version" IS NULL;--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "refund_policy_version" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "policy_snapshot" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "wallet_topups" ADD COLUMN "limits_version" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "order_settings_version_uq" ON "order_settings_versions" USING btree ("version");--> statement-breakpoint
CREATE UNIQUE INDEX "order_settings_previous_uq" ON "order_settings_versions" USING btree ("previous_version") WHERE "order_settings_versions"."previous_version" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_limit_approved_seq_uq" ON "wallet_limit_versions" USING btree ("approved_seq") WHERE "wallet_limit_versions"."approved_seq" is not null;--> statement-breakpoint
CREATE INDEX "wallet_limit_open_idx" ON "wallet_limit_versions" USING btree ("created_at") WHERE "wallet_limit_versions"."status" = 'REQUESTED';--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_refund_policy_version_refund_policy_versions_version_fk" FOREIGN KEY ("refund_policy_version") REFERENCES "public"."refund_policy_versions"("version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_policy_snapshot_object" CHECK (jsonb_typeof("orders"."policy_snapshot") = 'object');