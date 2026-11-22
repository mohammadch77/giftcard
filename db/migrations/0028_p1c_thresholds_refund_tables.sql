CREATE TABLE "catalog_legal_reviews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"status" text NOT NULL,
	"reviewed_by" text,
	"reference" text NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "catalog_legal_reviews_scope" CHECK ("catalog_legal_reviews"."scope" in ('GAME_ACCOUNT')),
	CONSTRAINT "catalog_legal_reviews_status" CHECK ("catalog_legal_reviews"."status" in ('PENDING','APPROVED','REJECTED')),
	CONSTRAINT "catalog_legal_reviews_ref" CHECK (char_length(btrim("catalog_legal_reviews"."reference")) >= 3),
	CONSTRAINT "catalog_legal_reviews_decision" CHECK (("catalog_legal_reviews"."status" = 'PENDING' and "catalog_legal_reviews"."reviewed_by" is null and "catalog_legal_reviews"."decided_at" is null)
        or ("catalog_legal_reviews"."status" in ('APPROVED','REJECTED') and "catalog_legal_reviews"."reviewed_by" is not null and "catalog_legal_reviews"."decided_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "refund_threshold_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"requires_tier2_above_rial" "rial_amount" NOT NULL,
	"auto_approval_allowed" boolean DEFAULT false NOT NULL,
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
	CONSTRAINT "refund_threshold_status" CHECK ("refund_threshold_versions"."status" in ('REQUESTED','APPROVED','REJECTED')),
	CONSTRAINT "refund_threshold_source" CHECK ("refund_threshold_versions"."source" in ('SEED','ADMIN')),
	CONSTRAINT "refund_threshold_bounds" CHECK ("refund_threshold_versions"."requires_tier2_above_rial" >= 0 and "refund_threshold_versions"."requires_tier2_above_rial" % 10 = 0 and "refund_threshold_versions"."requires_tier2_above_rial" <= 1000000000000),
	CONSTRAINT "refund_threshold_auto_approval" CHECK ("refund_threshold_versions"."auto_approval_allowed" = false),
	CONSTRAINT "refund_threshold_reason" CHECK (char_length(btrim("refund_threshold_versions"."reason")) >= 10),
	CONSTRAINT "refund_threshold_decision" CHECK (("refund_threshold_versions"."status" = 'REQUESTED' and "refund_threshold_versions"."decided_by" is null and "refund_threshold_versions"."decided_at" is null and "refund_threshold_versions"."approved_seq" is null)
        or ("refund_threshold_versions"."status" = 'APPROVED' and "refund_threshold_versions"."decided_by" is not null and "refund_threshold_versions"."decided_at" is not null and "refund_threshold_versions"."approved_seq" is not null and "refund_threshold_versions"."decided_by" <> "refund_threshold_versions"."requested_by" and char_length(btrim(coalesce("refund_threshold_versions"."decision_reason", ''))) >= 5)
        or ("refund_threshold_versions"."status" = 'REJECTED' and "refund_threshold_versions"."decided_by" is not null and "refund_threshold_versions"."decided_at" is not null and "refund_threshold_versions"."approved_seq" is null and "refund_threshold_versions"."decided_by" <> "refund_threshold_versions"."requested_by" and char_length(btrim(coalesce("refund_threshold_versions"."decision_reason", ''))) >= 5))
);
--> statement-breakpoint
CREATE TABLE "wallet_adjustment_threshold_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"requires_tier2_above_rial" "rial_amount" NOT NULL,
	"auto_approval_allowed" boolean DEFAULT false NOT NULL,
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
	CONSTRAINT "wallet_adj_threshold_status" CHECK ("wallet_adjustment_threshold_versions"."status" in ('REQUESTED','APPROVED','REJECTED')),
	CONSTRAINT "wallet_adj_threshold_source" CHECK ("wallet_adjustment_threshold_versions"."source" in ('SEED','ADMIN')),
	CONSTRAINT "wallet_adj_threshold_bounds" CHECK ("wallet_adjustment_threshold_versions"."requires_tier2_above_rial" >= 0 and "wallet_adjustment_threshold_versions"."requires_tier2_above_rial" % 10 = 0 and "wallet_adjustment_threshold_versions"."requires_tier2_above_rial" <= 1000000000000),
	CONSTRAINT "wallet_adj_threshold_auto_approval" CHECK ("wallet_adjustment_threshold_versions"."auto_approval_allowed" = false),
	CONSTRAINT "wallet_adj_threshold_reason" CHECK (char_length(btrim("wallet_adjustment_threshold_versions"."reason")) >= 10),
	CONSTRAINT "wallet_adj_threshold_decision" CHECK (("wallet_adjustment_threshold_versions"."status" = 'REQUESTED' and "wallet_adjustment_threshold_versions"."decided_by" is null and "wallet_adjustment_threshold_versions"."decided_at" is null and "wallet_adjustment_threshold_versions"."approved_seq" is null)
        or ("wallet_adjustment_threshold_versions"."status" = 'APPROVED' and "wallet_adjustment_threshold_versions"."decided_by" is not null and "wallet_adjustment_threshold_versions"."decided_at" is not null and "wallet_adjustment_threshold_versions"."approved_seq" is not null and "wallet_adjustment_threshold_versions"."decided_by" <> "wallet_adjustment_threshold_versions"."requested_by" and char_length(btrim(coalesce("wallet_adjustment_threshold_versions"."decision_reason", ''))) >= 5)
        or ("wallet_adjustment_threshold_versions"."status" = 'REJECTED' and "wallet_adjustment_threshold_versions"."decided_by" is not null and "wallet_adjustment_threshold_versions"."decided_at" is not null and "wallet_adjustment_threshold_versions"."approved_seq" is null and "wallet_adjustment_threshold_versions"."decided_by" <> "wallet_adjustment_threshold_versions"."requested_by" and char_length(btrim(coalesce("wallet_adjustment_threshold_versions"."decision_reason", ''))) >= 5))
);
--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "threshold_version" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "tier" text NOT NULL;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "evidence_references" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "review_reason" text;--> statement-breakpoint
ALTER TABLE "wallet_adjustments" ADD COLUMN "threshold_version" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "wallet_adjustments" ADD COLUMN "tier" text NOT NULL;--> statement-breakpoint
CREATE INDEX "catalog_legal_reviews_scope_idx" ON "catalog_legal_reviews" USING btree ("scope","status");--> statement-breakpoint
CREATE UNIQUE INDEX "refund_threshold_approved_seq_uq" ON "refund_threshold_versions" USING btree ("approved_seq") WHERE "refund_threshold_versions"."approved_seq" is not null;--> statement-breakpoint
CREATE INDEX "refund_threshold_open_idx" ON "refund_threshold_versions" USING btree ("created_at") WHERE "refund_threshold_versions"."status" = 'REQUESTED';--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_adj_threshold_approved_seq_uq" ON "wallet_adjustment_threshold_versions" USING btree ("approved_seq") WHERE "wallet_adjustment_threshold_versions"."approved_seq" is not null;--> statement-breakpoint
CREATE INDEX "wallet_adj_threshold_open_idx" ON "wallet_adjustment_threshold_versions" USING btree ("created_at") WHERE "wallet_adjustment_threshold_versions"."status" = 'REQUESTED';--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_tier" CHECK ("refunds"."tier" in ('TIER_1','TIER_2'));--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_review_reason" CHECK ("refunds"."review_reason" is null or "refunds"."review_reason" in ('DEFECTIVE_PRODUCT','INCORRECT_PRODUCT','MISREPRESENTED_PRODUCT','DUPLICATE_PAYMENT','SUPPLIER_FAILURE','SUPPLIER_UNKNOWN','FRAUD_REVIEW','FULFILLMENT_FAILURE','CUSTOMER_DISPUTE','REVEALED_DISPUTE'));--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_evidence_references" CHECK (jsonb_typeof("refunds"."evidence_references") = 'array' and jsonb_array_length("refunds"."evidence_references") <= 20 and pg_column_size("refunds"."evidence_references") <= 8192);--> statement-breakpoint
ALTER TABLE "wallet_adjustments" ADD CONSTRAINT "wallet_adjustments_tier" CHECK ("wallet_adjustments"."tier" in ('TIER_1','TIER_2'));