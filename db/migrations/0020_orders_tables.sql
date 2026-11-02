CREATE TABLE "order_holds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"opened_by" text NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"resolution" text,
	"note" text,
	CONSTRAINT "order_holds_reason" CHECK ("order_holds"."reason" in ('LATE_PAYMENT_NO_RESERVATION','PAYMENT_NEEDS_REVIEW','FRAUD_REVIEW','FULFILLMENT_FAILED','SUPPLIER_UNKNOWN')),
	CONSTRAINT "order_holds_resolution" CHECK ("order_holds"."resolution" is null or "order_holds"."resolution" in ('RE_RESERVED','RESUMED','REFUND_WALLET','REFUND_GATEWAY','SUBSTITUTED','CANCELLED')),
	CONSTRAINT "order_holds_resolved_complete" CHECK (("order_holds"."resolved_at" is null) = ("order_holds"."resolution" is null) and ("order_holds"."resolved_at" is null) = ("order_holds"."resolved_by" is null)),
	CONSTRAINT "order_holds_note" CHECK ("order_holds"."resolved_at" is null or char_length(btrim(coalesce("order_holds"."note", ''))) >= 10)
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"variant_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price" "rial_amount" NOT NULL,
	"line_total" "rial_amount" NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "order_items_qty" CHECK ("order_items"."quantity" between 1 and 100),
	CONSTRAINT "order_items_line_total" CHECK ("order_items"."line_total" = "order_items"."unit_price" * "order_items"."quantity")
);
--> statement-breakpoint
CREATE TABLE "order_status_history" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "order_status_history_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"entity_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"actor_id" text,
	"reason" text,
	"occurred_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"user_ref" text NOT NULL,
	"status" text DEFAULT 'PENDING_PAYMENT' NOT NULL,
	"payment_status" text DEFAULT 'PENDING' NOT NULL,
	"payment_method" text NOT NULL,
	"currency" text DEFAULT 'IRR' NOT NULL,
	"total" "rial_amount" NOT NULL,
	"pricing_version" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" "bytea" NOT NULL,
	"reservation_id" uuid,
	"payment_id" uuid,
	"settlement_ledger_txn_id" bigint,
	"expires_at" timestamp with time zone NOT NULL,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "orders_status" CHECK ("orders"."status" in ('PENDING_PAYMENT','PAID','FULFILLING','PARTIALLY_COMPLETED','COMPLETED','ON_HOLD','CANCELLED','EXPIRED')),
	CONSTRAINT "orders_payment_status" CHECK ("orders"."payment_status" in ('PENDING','SUCCEEDED','FAILED')),
	CONSTRAINT "orders_payment_method" CHECK ("orders"."payment_method" in ('WALLET','GATEWAY')),
	CONSTRAINT "orders_currency" CHECK ("orders"."currency" = 'IRR'),
	CONSTRAINT "orders_total_positive" CHECK ("orders"."total" > 0),
	CONSTRAINT "orders_method_payment" CHECK (("orders"."payment_method" = 'GATEWAY') or "orders"."payment_id" is null),
	CONSTRAINT "orders_paid_consistent" CHECK ("orders"."status" not in ('PAID','FULFILLING','PARTIALLY_COMPLETED','COMPLETED') or ("orders"."payment_status" = 'SUCCEEDED' and "orders"."paid_at" is not null)),
	CONSTRAINT "orders_pending_unpaid" CHECK ("orders"."status" <> 'PENDING_PAYMENT' or "orders"."payment_status" = 'PENDING')
);
--> statement-breakpoint
ALTER TABLE "order_holds" ADD CONSTRAINT "order_holds_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "order_holds_open_uq" ON "order_holds" USING btree ("order_id","reason") WHERE "order_holds"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "order_holds_open_idx" ON "order_holds" USING btree ("opened_at") WHERE "order_holds"."resolved_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "order_items_line_uq" ON "order_items" USING btree ("order_id","line_no");--> statement-breakpoint
CREATE UNIQUE INDEX "order_items_variant_uq" ON "order_items" USING btree ("order_id","variant_id");--> statement-breakpoint
CREATE INDEX "order_items_order_idx" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_number_uq" ON "orders" USING btree ("number");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_idempotency_uq" ON "orders" USING btree ("user_ref","idempotency_key");--> statement-breakpoint
CREATE INDEX "orders_user_idx" ON "orders" USING btree ("user_ref","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "orders_expiry_idx" ON "orders" USING btree ("expires_at") WHERE "orders"."status" = 'PENDING_PAYMENT';--> statement-breakpoint
CREATE INDEX "orders_payment_idx" ON "orders" USING btree ("payment_id") WHERE "orders"."payment_id" is not null;