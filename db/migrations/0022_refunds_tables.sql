CREATE TABLE "reconciliation_findings" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "reconciliation_findings_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"run_id" uuid NOT NULL,
	"job" text NOT NULL,
	"severity" text NOT NULL,
	"subject" text NOT NULL,
	"detail" text NOT NULL,
	"found_at" timestamp with time zone NOT NULL,
	CONSTRAINT "reconciliation_findings_severity" CHECK ("reconciliation_findings"."severity" in ('INFO','WARN','CRITICAL'))
);
--> statement-breakpoint
CREATE TABLE "reconciliation_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"started_by" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"jobs" text NOT NULL,
	"finding_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refund_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"refund_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"amount" "rial_amount" NOT NULL,
	"disclosure_state" text NOT NULL,
	CONSTRAINT "refund_items_state" CHECK ("refund_items"."disclosure_state" in ('NOT_DELIVERED','DELIVERED_UNREVEALED','REVEALED_BY_CUSTOMER','REVEALED_BY_ADMIN_ONLY'))
);
--> statement-breakpoint
CREATE TABLE "refund_policy_rules" (
	"version" text NOT NULL,
	"disclosure_state" text NOT NULL,
	"decision" text NOT NULL,
	CONSTRAINT "refund_policy_rules_state" CHECK ("refund_policy_rules"."disclosure_state" in ('NOT_DELIVERED','DELIVERED_UNREVEALED','REVEALED_BY_CUSTOMER','REVEALED_BY_ADMIN_ONLY')),
	CONSTRAINT "refund_policy_rules_decision" CHECK ("refund_policy_rules"."decision" in ('ELIGIBLE','REVIEW_REQUIRED','OVERRIDE_REQUIRED','DENIED'))
);
--> statement-breakpoint
CREATE TABLE "refund_policy_versions" (
	"version" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"legal_review_required" boolean NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"description" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "refund_policy_versions_status" CHECK ("refund_policy_versions"."status" in ('TEMPORARY','FINAL'))
);
--> statement-breakpoint
CREATE TABLE "refund_status_history" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "refund_status_history_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"entity_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"actor_id" text,
	"reason" text,
	"occurred_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"hold_id" uuid,
	"source" text NOT NULL,
	"suspense_key" text,
	"payment_id" uuid,
	"requested_by" text NOT NULL,
	"requester_type" text NOT NULL,
	"reason_code" text NOT NULL,
	"amount" "rial_amount" NOT NULL,
	"destination" text NOT NULL,
	"status" text DEFAULT 'REQUESTED' NOT NULL,
	"policy_version" text NOT NULL,
	"eligibility_snapshot" jsonb NOT NULL,
	"decision" text NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"override_reason" text,
	"external_outcome" text DEFAULT 'NONE' NOT NULL,
	"gateway_refund_ref" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"ledger_txn_id" bigint,
	"request_hash" "bytea" NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "refunds_status" CHECK ("refunds"."status" in ('REQUESTED','APPROVED','REJECTED','PROCESSING','COMPLETED','FAILED')),
	CONSTRAINT "refunds_source" CHECK (("refunds"."source" = 'ORDER_PAYMENT' and "refunds"."suspense_key" is null) or ("refunds"."source" = 'SUSPENSE_RECEIPT' and "refunds"."suspense_key" is not null and "refunds"."hold_id" is not null)),
	CONSTRAINT "refunds_destination" CHECK ("refunds"."destination" in ('WALLET','GATEWAY')),
	CONSTRAINT "refunds_requester" CHECK ("refunds"."requester_type" in ('CUSTOMER','ADMIN')),
	CONSTRAINT "refunds_decision" CHECK ("refunds"."decision" in ('ELIGIBLE','REVIEW_REQUIRED','OVERRIDE_REQUIRED','DENIED')),
	CONSTRAINT "refunds_outcome" CHECK ("refunds"."external_outcome" in ('NONE','ACCEPTED','UNKNOWN','CONFIRMED','REJECTED')),
	CONSTRAINT "refunds_amount" CHECK ("refunds"."amount" > 0),
	CONSTRAINT "refunds_gateway_needs_payment" CHECK ("refunds"."destination" <> 'GATEWAY' or "refunds"."payment_id" is not null),
	CONSTRAINT "refunds_decided" CHECK ("refunds"."status" in ('REQUESTED') or ("refunds"."decided_by" is not null and "refunds"."decided_at" is not null and char_length(btrim(coalesce("refunds"."decision_note", ''))) >= 5)),
	CONSTRAINT "refunds_four_eyes" CHECK ("refunds"."requester_type" <> 'ADMIN' or "refunds"."decided_by" is null or "refunds"."decided_by" <> "refunds"."requested_by"),
	CONSTRAINT "refunds_denied_not_approved" CHECK ("refunds"."decision" <> 'DENIED' or "refunds"."status" in ('REQUESTED','REJECTED')),
	CONSTRAINT "refunds_override" CHECK ("refunds"."decision" <> 'OVERRIDE_REQUIRED' or "refunds"."status" in ('REQUESTED','REJECTED') or char_length(btrim(coalesce("refunds"."override_reason", ''))) >= 10),
	CONSTRAINT "refunds_completed" CHECK ("refunds"."status" <> 'COMPLETED' or ("refunds"."ledger_txn_id" is not null and "refunds"."completed_at" is not null and ("refunds"."destination" <> 'GATEWAY' or "refunds"."external_outcome" = 'CONFIRMED')))
);
--> statement-breakpoint
ALTER TABLE "reconciliation_findings" ADD CONSTRAINT "reconciliation_findings_run_id_reconciliation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."reconciliation_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_items" ADD CONSTRAINT "refund_items_refund_id_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refunds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_items" ADD CONSTRAINT "refund_items_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_policy_rules" ADD CONSTRAINT "refund_policy_rules_version_refund_policy_versions_version_fk" FOREIGN KEY ("version") REFERENCES "public"."refund_policy_versions"("version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_hold_id_order_holds_id_fk" FOREIGN KEY ("hold_id") REFERENCES "public"."order_holds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_policy_version_refund_policy_versions_version_fk" FOREIGN KEY ("policy_version") REFERENCES "public"."refund_policy_versions"("version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reconciliation_findings_run_idx" ON "reconciliation_findings" USING btree ("run_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "refund_items_uq" ON "refund_items" USING btree ("refund_id","order_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "refund_policy_rules_uq" ON "refund_policy_rules" USING btree ("version","disclosure_state");--> statement-breakpoint
CREATE UNIQUE INDEX "refund_policy_active_uq" ON "refund_policy_versions" USING btree ("active") WHERE "refund_policy_versions"."active";--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_one_per_order_uq" ON "refunds" USING btree ("order_id") WHERE "refunds"."status" <> 'REJECTED';--> statement-breakpoint
CREATE INDEX "refunds_open_idx" ON "refunds" USING btree ("created_at") WHERE "refunds"."status" in ('REQUESTED','APPROVED','PROCESSING','FAILED');