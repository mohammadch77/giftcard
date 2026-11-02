CREATE TABLE "payment_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "payment_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"payment_id" uuid NOT NULL,
	"gateway" text NOT NULL,
	"event_key" text NOT NULL,
	"kind" text NOT NULL,
	"raw" jsonb,
	"received_at" timestamp with time zone NOT NULL,
	CONSTRAINT "payment_events_kind" CHECK ("payment_events"."kind" in ('CALLBACK','VERIFY_REPLY'))
);
--> statement-breakpoint
CREATE TABLE "payment_status_history" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "payment_status_history_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"entity_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"actor_id" text,
	"reason" text,
	"occurred_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"purpose" text NOT NULL,
	"order_ref" text,
	"topup_ref" text,
	"user_ref" text NOT NULL,
	"gateway" text NOT NULL,
	"gateway_ref" text,
	"amount" "rial_amount" NOT NULL,
	"currency" char(3) DEFAULT 'IRR' NOT NULL,
	"status" text DEFAULT 'INITIATED' NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" "bytea" NOT NULL,
	"verifying_since" timestamp with time zone,
	"verify_attempts" integer DEFAULT 0 NOT NULL,
	"verified_at" timestamp with time zone,
	"verified_amount" "rial_amount",
	"review_reason" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "payments_purpose" CHECK ("payments"."purpose" in ('ORDER','WALLET_TOPUP')),
	CONSTRAINT "payments_one_target" CHECK (("payments"."purpose" = 'ORDER' and "payments"."order_ref" is not null and "payments"."topup_ref" is null) or ("payments"."purpose" = 'WALLET_TOPUP' and "payments"."topup_ref" is not null and "payments"."order_ref" is null)),
	CONSTRAINT "payments_amount_positive" CHECK ("payments"."amount" > 0),
	CONSTRAINT "payments_currency" CHECK ("payments"."currency" = 'IRR'),
	CONSTRAINT "payments_status" CHECK ("payments"."status" in ('INITIATED','PENDING','VERIFYING','SUCCEEDED','FAILED','NEEDS_REVIEW','EXPIRED','CANCELLED')),
	CONSTRAINT "payments_gateway_key" CHECK ("payments"."gateway" ~ '^[a-z][a-z0-9_-]{0,39}$'),
	CONSTRAINT "payments_succeeded_verified" CHECK ("payments"."status" <> 'SUCCEEDED' or ("payments"."verified_at" is not null and "payments"."verified_amount" = "payments"."amount" and "payments"."gateway_ref" is not null)),
	CONSTRAINT "payments_pending_has_ref" CHECK ("payments"."status" not in ('PENDING','VERIFYING') or "payments"."gateway_ref" is not null)
);
--> statement-breakpoint
CREATE TABLE "wallet_adjustments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_ref" text NOT NULL,
	"direction" text NOT NULL,
	"amount" "rial_amount" NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'REQUESTED' NOT NULL,
	"requested_by" text NOT NULL,
	"decided_by" text,
	"decision_reason" text,
	"ledger_txn_id" bigint,
	"created_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "wallet_adjustments_direction" CHECK ("wallet_adjustments"."direction" in ('CREDIT','DEBIT')),
	CONSTRAINT "wallet_adjustments_status" CHECK ("wallet_adjustments"."status" in ('REQUESTED','COMPLETED','REJECTED')),
	CONSTRAINT "wallet_adjustments_amount" CHECK ("wallet_adjustments"."amount" > 0),
	CONSTRAINT "wallet_adjustments_reason" CHECK (char_length(btrim("wallet_adjustments"."reason")) >= 10),
	CONSTRAINT "wallet_adjustments_four_eyes" CHECK ("wallet_adjustments"."decided_by" is null or "wallet_adjustments"."decided_by" <> "wallet_adjustments"."requested_by"),
	CONSTRAINT "wallet_adjustments_decided" CHECK ("wallet_adjustments"."status" = 'REQUESTED' or ("wallet_adjustments"."decided_by" is not null and "wallet_adjustments"."decided_at" is not null and char_length(btrim(coalesce("wallet_adjustments"."decision_reason", ''))) >= 5)),
	CONSTRAINT "wallet_adjustments_completed" CHECK ("wallet_adjustments"."status" <> 'COMPLETED' or "wallet_adjustments"."ledger_txn_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "wallet_topups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_ref" text NOT NULL,
	"amount" "rial_amount" NOT NULL,
	"status" text DEFAULT 'REQUESTED' NOT NULL,
	"payment_id" uuid,
	"idempotency_key" text NOT NULL,
	"request_hash" "bytea" NOT NULL,
	"ledger_txn_id" bigint,
	"created_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "wallet_topups_status" CHECK ("wallet_topups"."status" in ('REQUESTED','COMPLETED','FAILED')),
	CONSTRAINT "wallet_topups_amount" CHECK ("wallet_topups"."amount" > 0 and "wallet_topups"."amount" % 10 = 0),
	CONSTRAINT "wallet_topups_completed" CHECK ("wallet_topups"."status" <> 'COMPLETED' or ("wallet_topups"."ledger_txn_id" is not null and "wallet_topups"."completed_at" is not null and "wallet_topups"."payment_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_events_dedupe_uq" ON "payment_events" USING btree ("gateway","event_key");--> statement-breakpoint
CREATE INDEX "payment_events_payment_idx" ON "payment_events" USING btree ("payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_idempotency_uq" ON "payments" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_gateway_ref_uq" ON "payments" USING btree ("gateway","gateway_ref") WHERE "payments"."gateway_ref" is not null;--> statement-breakpoint
CREATE INDEX "payments_user_idx" ON "payments" USING btree ("user_ref","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "payments_order_idx" ON "payments" USING btree ("order_ref") WHERE "payments"."order_ref" is not null;--> statement-breakpoint
CREATE INDEX "payments_topup_idx" ON "payments" USING btree ("topup_ref") WHERE "payments"."topup_ref" is not null;--> statement-breakpoint
CREATE INDEX "payments_verifying_idx" ON "payments" USING btree ("verifying_since") WHERE "payments"."status" = 'VERIFYING';--> statement-breakpoint
CREATE INDEX "wallet_adjustments_user_idx" ON "wallet_adjustments" USING btree ("user_ref","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "wallet_adjustments_open_idx" ON "wallet_adjustments" USING btree ("created_at") WHERE "wallet_adjustments"."status" = 'REQUESTED';--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_topups_idempotency_uq" ON "wallet_topups" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_topups_payment_uq" ON "wallet_topups" USING btree ("payment_id") WHERE "wallet_topups"."payment_id" is not null;--> statement-breakpoint
CREATE INDEX "wallet_topups_user_idx" ON "wallet_topups" USING btree ("user_ref","created_at" DESC NULLS LAST);