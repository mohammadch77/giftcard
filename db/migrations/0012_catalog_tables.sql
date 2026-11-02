CREATE TABLE "brands" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "brands_slug_format" CHECK ("brands"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length("brands"."slug") <= 80),
	CONSTRAINT "brands_name_len" CHECK (char_length(btrim("brands"."name")) between 1 and 120),
	CONSTRAINT "brands_status" CHECK ("brands"."status" in ('ACTIVE','ARCHIVED'))
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"parent_id" uuid,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "categories_slug_format" CHECK ("categories"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length("categories"."slug") <= 80),
	CONSTRAINT "categories_name_len" CHECK (char_length(btrim("categories"."name")) between 1 and 120),
	CONSTRAINT "categories_status" CHECK ("categories"."status" in ('ACTIVE','ARCHIVED')),
	CONSTRAINT "categories_not_own_parent" CHECK ("categories"."parent_id" is null or "categories"."parent_id" <> "categories"."id")
);
--> statement-breakpoint
CREATE TABLE "product_status_history" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "product_status_history_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"entity_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"actor_id" text,
	"reason" text,
	"occurred_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_type_fulfillment" (
	"product_type" text NOT NULL,
	"method" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_variants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"product_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"region_id" uuid,
	"face_value" bigint,
	"face_currency" char(3),
	"duration_days" integer,
	"fulfillment_method" text NOT NULL,
	"price" "rial_price" NOT NULL,
	"sale_price" "rial_price",
	"sale_starts_at" timestamp with time zone,
	"sale_ends_at" timestamp with time zone,
	"attrs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"availability" text DEFAULT 'AVAILABLE' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "variants_sku_format" CHECK ("product_variants"."sku" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
	CONSTRAINT "variants_name_len" CHECK (char_length(btrim("product_variants"."name")) between 1 and 200),
	CONSTRAINT "variants_fulfillment" CHECK ("product_variants"."fulfillment_method" in ('AUTO_CODE','MANUAL','SUPPLIER_API')),
	CONSTRAINT "variants_status" CHECK ("product_variants"."status" in ('DRAFT','PUBLISHED','ARCHIVED')),
	CONSTRAINT "variants_availability" CHECK ("product_variants"."availability" in ('AVAILABLE','TEMPORARILY_UNAVAILABLE')),
	CONSTRAINT "variants_face_pair" CHECK (("product_variants"."face_value" is null) = ("product_variants"."face_currency" is null)),
	CONSTRAINT "variants_face_positive" CHECK ("product_variants"."face_value" is null or "product_variants"."face_value" > 0),
	CONSTRAINT "variants_duration" CHECK ("product_variants"."duration_days" is null or "product_variants"."duration_days" between 1 and 3660),
	CONSTRAINT "variants_sale_lower" CHECK ("product_variants"."sale_price" is null or ("product_variants"."sale_price" > 0 and "product_variants"."sale_price" < "product_variants"."price")),
	CONSTRAINT "variants_sale_window" CHECK ("product_variants"."sale_ends_at" is null or "product_variants"."sale_starts_at" is null or "product_variants"."sale_ends_at" > "product_variants"."sale_starts_at"),
	CONSTRAINT "variants_sale_window_needs_price" CHECK ("product_variants"."sale_price" is not null or ("product_variants"."sale_starts_at" is null and "product_variants"."sale_ends_at" is null)),
	CONSTRAINT "variants_attrs_object" CHECK (jsonb_typeof("product_variants"."attrs") = 'object' and pg_column_size("product_variants"."attrs") <= 8192)
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"brand_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "products_type" CHECK ("products"."type" in ('GIFT_CARD','GAME_ACCOUNT','GAME_SUBSCRIPTION','STREAMING_SUBSCRIPTION','DIGITAL_SERVICE','OTHER')),
	CONSTRAINT "products_slug_format" CHECK ("products"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length("products"."slug") <= 120),
	CONSTRAINT "products_name_len" CHECK (char_length(btrim("products"."name")) between 1 and 200),
	CONSTRAINT "products_description_len" CHECK ("products"."description" is null or char_length("products"."description") <= 5000),
	CONSTRAINT "products_status" CHECK ("products"."status" in ('DRAFT','PUBLISHED','ARCHIVED'))
);
--> statement-breakpoint
CREATE TABLE "regions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "regions_code_format" CHECK ("regions"."code" ~ '^[A-Z]{2,8}$'),
	CONSTRAINT "regions_name_len" CHECK (char_length(btrim("regions"."name")) between 1 and 80)
);
--> statement-breakpoint
CREATE TABLE "variant_price_history" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "variant_price_history_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"variant_id" uuid NOT NULL,
	"price" "rial_price" NOT NULL,
	"sale_price" "rial_price",
	"sale_starts_at" timestamp with time zone,
	"sale_ends_at" timestamp with time zone,
	"changed_by" text,
	"reason" text,
	"changed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "variant_status_history" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "variant_status_history_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"entity_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"actor_id" text,
	"reason" text,
	"occurred_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_region_id_regions_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."regions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_price_history" ADD CONSTRAINT "variant_price_history_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "brands_slug_uq" ON "brands" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "categories_slug_uq" ON "categories" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "categories_parent_idx" ON "categories" USING btree ("parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_type_fulfillment_uq" ON "product_type_fulfillment" USING btree ("product_type","method");--> statement-breakpoint
CREATE UNIQUE INDEX "product_variants_sku_uq" ON "product_variants" USING btree ("product_id","sku");--> statement-breakpoint
CREATE INDEX "product_variants_published_idx" ON "product_variants" USING btree ("product_id") WHERE "product_variants"."status" = 'PUBLISHED';--> statement-breakpoint
CREATE UNIQUE INDEX "products_slug_uq" ON "products" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "products_listing_idx" ON "products" USING btree ("brand_id","category_id") WHERE "products"."status" = 'PUBLISHED';--> statement-breakpoint
CREATE INDEX "products_category_idx" ON "products" USING btree ("category_id");--> statement-breakpoint
CREATE UNIQUE INDEX "regions_code_uq" ON "regions" USING btree ("code");--> statement-breakpoint
CREATE INDEX "variant_price_history_variant_idx" ON "variant_price_history" USING btree ("variant_id","id" DESC NULLS LAST);