CREATE TABLE "code_access_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "code_access_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"code_id" uuid NOT NULL,
	"order_item_ref" text NOT NULL,
	"requested_by" text NOT NULL,
	"purpose" text NOT NULL,
	"accessed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "digital_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"variant_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"code_fp" "bytea" NOT NULL,
	"hmac_version" integer NOT NULL,
	"sealed" "bytea" NOT NULL,
	"payload_kind" text NOT NULL,
	"status" text DEFAULT 'AVAILABLE' NOT NULL,
	"reservation_id" uuid,
	"reserved_until" timestamp with time zone,
	"order_item_ref" text,
	"sold_at" timestamp with time zone,
	"public_attrs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "digital_codes_status" CHECK ("digital_codes"."status" in ('AVAILABLE','RESERVED','SOLD','VOID','QUARANTINED')),
	CONSTRAINT "digital_codes_payload_kind" CHECK ("digital_codes"."payload_kind" in ('CODE','ACCOUNT')),
	CONSTRAINT "digital_codes_fp_len" CHECK (octet_length("digital_codes"."code_fp") = 32),
	CONSTRAINT "digital_codes_status_links" CHECK (("digital_codes"."status" = 'AVAILABLE' and "digital_codes"."reservation_id" is null and "digital_codes"."order_item_ref" is null and "digital_codes"."reserved_until" is null)
       or ("digital_codes"."status" = 'RESERVED' and "digital_codes"."reservation_id" is not null and "digital_codes"."order_item_ref" is null and "digital_codes"."reserved_until" is not null)
       or ("digital_codes"."status" = 'SOLD' and "digital_codes"."order_item_ref" is not null and "digital_codes"."sold_at" is not null)
       or ("digital_codes"."status" in ('VOID','QUARANTINED'))),
	CONSTRAINT "digital_codes_attrs" CHECK (jsonb_typeof("digital_codes"."public_attrs") = 'object' and pg_column_size("digital_codes"."public_attrs") <= 2048)
);
--> statement-breakpoint
CREATE TABLE "inventory_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"variant_id" uuid NOT NULL,
	"code_count" integer NOT NULL,
	"duplicate_count" integer DEFAULT 0 NOT NULL,
	"note" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "inventory_batches_counts" CHECK ("inventory_batches"."code_count" >= 0 and "inventory_batches"."duplicate_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_movements" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "inventory_movements_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"variant_id" uuid NOT NULL,
	"code_id" uuid,
	"reservation_id" uuid,
	"type" text NOT NULL,
	"qty_delta" integer NOT NULL,
	"order_item_ref" text,
	"reason" text,
	"actor" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "inventory_movements_type" CHECK ("inventory_movements"."type" in ('IMPORT','RESERVE','RELEASE','EXPIRE','SELL','VOID','QUARANTINE','UNQUARANTINE','ADJUST'))
);
--> statement-breakpoint
CREATE TABLE "inventory_reservation_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"reservation_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"quantity" integer NOT NULL,
	"sold_at" timestamp with time zone,
	CONSTRAINT "inventory_reservation_lines_kind" CHECK ("inventory_reservation_lines"."kind" in ('ITEMISED','COUNTED')),
	CONSTRAINT "inventory_reservation_lines_qty" CHECK ("inventory_reservation_lines"."quantity" between 1 and 1000)
);
--> statement-breakpoint
CREATE TABLE "inventory_reservations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"reservation_key" text NOT NULL,
	"order_ref" text NOT NULL,
	"request_hash" "bytea" NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	CONSTRAINT "inventory_reservations_status" CHECK ("inventory_reservations"."status" in ('ACTIVE','CONSUMED','RELEASED','EXPIRED')),
	CONSTRAINT "inventory_reservations_key_len" CHECK (char_length("inventory_reservations"."reservation_key") between 1 and 200 and char_length("inventory_reservations"."order_ref") between 1 and 200),
	CONSTRAINT "inventory_reservations_ttl" CHECK ("inventory_reservations"."expires_at" > "inventory_reservations"."created_at"),
	CONSTRAINT "inventory_reservations_consumed_in_time" CHECK ("inventory_reservations"."status" <> 'CONSUMED' or ("inventory_reservations"."consumed_at" is not null and "inventory_reservations"."consumed_at" < "inventory_reservations"."expires_at")),
	CONSTRAINT "inventory_reservations_closed" CHECK (("inventory_reservations"."status" in ('RELEASED','EXPIRED')) = ("inventory_reservations"."closed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "stock_counters" (
	"variant_id" uuid PRIMARY KEY NOT NULL,
	"available" integer DEFAULT 0 NOT NULL,
	"reserved" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "stock_counters_non_negative" CHECK ("stock_counters"."available" >= 0 and "stock_counters"."reserved" >= 0)
);
--> statement-breakpoint
ALTER TABLE "digital_codes" ADD CONSTRAINT "digital_codes_batch_id_inventory_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."inventory_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digital_codes" ADD CONSTRAINT "digital_codes_reservation_id_inventory_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."inventory_reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_reservation_lines" ADD CONSTRAINT "inventory_reservation_lines_reservation_id_inventory_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."inventory_reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "code_access_log_code_idx" ON "code_access_log" USING btree ("code_id");--> statement-breakpoint
CREATE UNIQUE INDEX "digital_codes_fp_uq" ON "digital_codes" USING btree ("hmac_version","code_fp");--> statement-breakpoint
CREATE UNIQUE INDEX "digital_codes_order_item_uq" ON "digital_codes" USING btree ("order_item_ref") WHERE "digital_codes"."order_item_ref" is not null;--> statement-breakpoint
CREATE INDEX "digital_codes_available_idx" ON "digital_codes" USING btree ("variant_id","id") WHERE "digital_codes"."status" = 'AVAILABLE';--> statement-breakpoint
CREATE INDEX "digital_codes_reservation_idx" ON "digital_codes" USING btree ("reservation_id") WHERE "digital_codes"."status" = 'RESERVED';--> statement-breakpoint
CREATE INDEX "digital_codes_batch_idx" ON "digital_codes" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "inventory_batches_variant_idx" ON "inventory_batches" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "inventory_movements_variant_idx" ON "inventory_movements" USING btree ("variant_id","id");--> statement-breakpoint
CREATE INDEX "inventory_movements_reservation_idx" ON "inventory_movements" USING btree ("reservation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_reservation_lines_uq" ON "inventory_reservation_lines" USING btree ("reservation_id","variant_id");--> statement-breakpoint
CREATE INDEX "inventory_reservation_lines_variant_idx" ON "inventory_reservation_lines" USING btree ("variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_reservations_key_uq" ON "inventory_reservations" USING btree ("reservation_key");--> statement-breakpoint
CREATE INDEX "inventory_reservations_expiry_idx" ON "inventory_reservations" USING btree ("expires_at") WHERE "inventory_reservations"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "inventory_reservations_order_idx" ON "inventory_reservations" USING btree ("order_ref");