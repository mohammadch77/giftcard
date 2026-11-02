CREATE TABLE "deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_item_ref" text NOT NULL,
	"user_ref" text NOT NULL,
	"kind" text NOT NULL,
	"code_ref" uuid,
	"delivered_at" timestamp with time zone NOT NULL,
	"first_revealed_at" timestamp with time zone,
	"first_revealed_by_type" text,
	"last_revealed_at" timestamp with time zone,
	"reveal_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "deliveries_kind" CHECK ("deliveries"."kind" in ('INVENTORY_CODE','SUPPLIER_CODE','MANUAL_CREDENTIAL')),
	CONSTRAINT "deliveries_code_ref" CHECK (("deliveries"."kind" = 'INVENTORY_CODE') = ("deliveries"."code_ref" is not null)),
	CONSTRAINT "deliveries_reveal" CHECK ("deliveries"."reveal_count" >= 0 and (("deliveries"."reveal_count" = 0) = ("deliveries"."first_revealed_at" is null))),
	CONSTRAINT "deliveries_first_by" CHECK ("deliveries"."first_revealed_by_type" is null or "deliveries"."first_revealed_by_type" in ('CUSTOMER','ADMIN'))
);
--> statement-breakpoint
CREATE TABLE "delivery_secrets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"delivery_id" uuid NOT NULL,
	"sealed" "bytea" NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fulfillment_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "fulfillment_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"task_id" uuid NOT NULL,
	"type" text NOT NULL,
	"detail" text,
	"actor" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fulfillment_tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_ref" text NOT NULL,
	"order_item_ref" text NOT NULL,
	"user_ref" text NOT NULL,
	"variant_id" uuid NOT NULL,
	"method" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"assignee" text,
	"attempt" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"supplier_order_id" uuid,
	"payment_ref" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "fulfillment_tasks_method" CHECK ("fulfillment_tasks"."method" in ('AUTO_CODE','MANUAL','SUPPLIER_API')),
	CONSTRAINT "fulfillment_tasks_status" CHECK ("fulfillment_tasks"."status" in ('PENDING','PROCESSING','COMPLETED','FAILED','CANCELLED')),
	CONSTRAINT "fulfillment_tasks_completed" CHECK (("fulfillment_tasks"."status" = 'COMPLETED') = ("fulfillment_tasks"."completed_at" is not null)),
	CONSTRAINT "fulfillment_tasks_processing_manual" CHECK ("fulfillment_tasks"."status" <> 'PROCESSING' or "fulfillment_tasks"."method" <> 'MANUAL' or "fulfillment_tasks"."assignee" is not null)
);
--> statement-breakpoint
CREATE TABLE "secret_access_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "secret_access_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"delivery_id" uuid NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "secret_access_log_actor" CHECK ("secret_access_log"."actor_type" in ('CUSTOMER','ADMIN')),
	CONSTRAINT "secret_access_log_action" CHECK ("secret_access_log"."action" in ('REVEAL','ADMIN_REVEAL'))
);
--> statement-breakpoint
CREATE TABLE "supplier_credentials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"supplier_id" uuid NOT NULL,
	"sealed" "bytea" NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"replaced_at" timestamp with time zone,
	CONSTRAINT "supplier_credentials_status" CHECK ("supplier_credentials"."status" in ('ACTIVE','REPLACED'))
);
--> statement-breakpoint
CREATE TABLE "supplier_order_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "supplier_order_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"supplier_order_id" uuid NOT NULL,
	"type" text NOT NULL,
	"detail" jsonb,
	"actor" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier_order_secrets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"supplier_order_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"sealed" "bytea" NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier_orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"supplier_id" uuid NOT NULL,
	"supplier_product_id" uuid NOT NULL,
	"order_item_ref" text NOT NULL,
	"quantity" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" "bytea" NOT NULL,
	"status" text DEFAULT 'CREATED' NOT NULL,
	"external_ref" text,
	"reject_reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"submitting_since" timestamp with time zone,
	"note" text,
	"request_redacted" jsonb,
	"response_redacted" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "supplier_orders_status" CHECK ("supplier_orders"."status" in ('CREATED','SUBMITTING','CONFIRMED','REJECTED','UNKNOWN')),
	CONSTRAINT "supplier_orders_quantity" CHECK ("supplier_orders"."quantity" between 1 and 100),
	CONSTRAINT "supplier_orders_key_len" CHECK (char_length("supplier_orders"."idempotency_key") between 1 and 200),
	CONSTRAINT "supplier_orders_confirmed" CHECK ("supplier_orders"."status" <> 'CONFIRMED' or "supplier_orders"."external_ref" is not null or char_length(btrim(coalesce("supplier_orders"."note", ''))) >= 5)
);
--> statement-breakpoint
CREATE TABLE "supplier_product_changes" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "supplier_product_changes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"supplier_product_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"old_cost" "rial_amount",
	"new_cost" "rial_amount" NOT NULL,
	"old_available" boolean,
	"new_available" boolean NOT NULL,
	"changed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier_products" (
	"id" uuid PRIMARY KEY NOT NULL,
	"supplier_id" uuid NOT NULL,
	"external_sku" text NOT NULL,
	"name" text NOT NULL,
	"cost" "rial_amount" NOT NULL,
	"available" boolean NOT NULL,
	"stock_hint" integer,
	"raw_hash" "bytea" NOT NULL,
	"last_synced_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "supplier_products_sku_format" CHECK ("supplier_products"."external_sku" ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$'),
	CONSTRAINT "supplier_products_stock" CHECK ("supplier_products"."stock_hint" is null or "supplier_products"."stock_hint" >= 0)
);
--> statement-breakpoint
CREATE TABLE "supplier_sync_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"supplier_id" uuid NOT NULL,
	"status" text DEFAULT 'RUNNING' NOT NULL,
	"fetched" integer DEFAULT 0 NOT NULL,
	"created" integer DEFAULT 0 NOT NULL,
	"updated" integer DEFAULT 0 NOT NULL,
	"rejected" integer DEFAULT 0 NOT NULL,
	"error_kind" text,
	"started_by" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "supplier_sync_runs_status" CHECK ("supplier_sync_runs"."status" in ('RUNNING','SUCCEEDED','FAILED'))
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"adapter_key" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "suppliers_key_format" CHECK ("suppliers"."key" ~ '^[a-z][a-z0-9_-]{1,39}$'),
	CONSTRAINT "suppliers_adapter_format" CHECK ("suppliers"."adapter_key" ~ '^[a-z][a-z0-9_-]{0,39}$'),
	CONSTRAINT "suppliers_name_len" CHECK (char_length(btrim("suppliers"."name")) between 1 and 120),
	CONSTRAINT "suppliers_status" CHECK ("suppliers"."status" in ('ACTIVE','DISABLED')),
	CONSTRAINT "suppliers_config" CHECK (jsonb_typeof("suppliers"."config") = 'object' and pg_column_size("suppliers"."config") <= 4096)
);
--> statement-breakpoint
CREATE TABLE "variant_supplier_routes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"variant_id" uuid NOT NULL,
	"supplier_product_id" uuid NOT NULL,
	"priority" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "variant_supplier_routes_priority" CHECK ("variant_supplier_routes"."priority" between 1 and 20)
);
--> statement-breakpoint
ALTER TABLE "delivery_secrets" ADD CONSTRAINT "delivery_secrets_delivery_id_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillment_events" ADD CONSTRAINT "fulfillment_events_task_id_fulfillment_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."fulfillment_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_access_log" ADD CONSTRAINT "secret_access_log_delivery_id_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_credentials" ADD CONSTRAINT "supplier_credentials_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_order_events" ADD CONSTRAINT "supplier_order_events_supplier_order_id_supplier_orders_id_fk" FOREIGN KEY ("supplier_order_id") REFERENCES "public"."supplier_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_order_secrets" ADD CONSTRAINT "supplier_order_secrets_supplier_order_id_supplier_orders_id_fk" FOREIGN KEY ("supplier_order_id") REFERENCES "public"."supplier_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_orders" ADD CONSTRAINT "supplier_orders_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_orders" ADD CONSTRAINT "supplier_orders_supplier_product_id_supplier_products_id_fk" FOREIGN KEY ("supplier_product_id") REFERENCES "public"."supplier_products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_product_changes" ADD CONSTRAINT "supplier_product_changes_supplier_product_id_supplier_products_id_fk" FOREIGN KEY ("supplier_product_id") REFERENCES "public"."supplier_products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_product_changes" ADD CONSTRAINT "supplier_product_changes_run_id_supplier_sync_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."supplier_sync_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_products" ADD CONSTRAINT "supplier_products_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_sync_runs" ADD CONSTRAINT "supplier_sync_runs_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_supplier_routes" ADD CONSTRAINT "variant_supplier_routes_supplier_product_id_supplier_products_id_fk" FOREIGN KEY ("supplier_product_id") REFERENCES "public"."supplier_products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "deliveries_item_uq" ON "deliveries" USING btree ("order_item_ref");--> statement-breakpoint
CREATE INDEX "deliveries_user_idx" ON "deliveries" USING btree ("user_ref","delivered_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_secrets_delivery_uq" ON "delivery_secrets" USING btree ("delivery_id");--> statement-breakpoint
CREATE INDEX "fulfillment_events_task_idx" ON "fulfillment_events" USING btree ("task_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "fulfillment_tasks_item_uq" ON "fulfillment_tasks" USING btree ("order_item_ref");--> statement-breakpoint
CREATE INDEX "fulfillment_tasks_queue_idx" ON "fulfillment_tasks" USING btree ("method","created_at") WHERE "fulfillment_tasks"."status" in ('PENDING','FAILED');--> statement-breakpoint
CREATE INDEX "fulfillment_tasks_order_idx" ON "fulfillment_tasks" USING btree ("order_ref");--> statement-breakpoint
CREATE INDEX "secret_access_log_delivery_idx" ON "secret_access_log" USING btree ("delivery_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_credentials_active_uq" ON "supplier_credentials" USING btree ("supplier_id") WHERE "supplier_credentials"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "supplier_order_events_order_idx" ON "supplier_order_events" USING btree ("supplier_order_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_order_secrets_pos_uq" ON "supplier_order_secrets" USING btree ("supplier_order_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_orders_idempotency_uq" ON "supplier_orders" USING btree ("supplier_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "supplier_orders_item_idx" ON "supplier_orders" USING btree ("order_item_ref");--> statement-breakpoint
CREATE INDEX "supplier_orders_open_idx" ON "supplier_orders" USING btree ("status","updated_at") WHERE "supplier_orders"."status" in ('SUBMITTING','UNKNOWN');--> statement-breakpoint
CREATE INDEX "supplier_product_changes_product_idx" ON "supplier_product_changes" USING btree ("supplier_product_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_products_sku_uq" ON "supplier_products" USING btree ("supplier_id","external_sku");--> statement-breakpoint
CREATE INDEX "supplier_sync_runs_supplier_idx" ON "supplier_sync_runs" USING btree ("supplier_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "suppliers_key_uq" ON "suppliers" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "variant_supplier_routes_product_uq" ON "variant_supplier_routes" USING btree ("variant_id","supplier_product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "variant_supplier_routes_priority_uq" ON "variant_supplier_routes" USING btree ("variant_id","priority") WHERE "variant_supplier_routes"."active";--> statement-breakpoint
CREATE INDEX "variant_supplier_routes_lookup_idx" ON "variant_supplier_routes" USING btree ("variant_id","priority") WHERE "variant_supplier_routes"."active";