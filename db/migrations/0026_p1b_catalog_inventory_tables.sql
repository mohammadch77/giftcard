CREATE TABLE "game_account_attributes" (
	"variant_id" uuid PRIMARY KEY NOT NULL,
	"account_type" text NOT NULL,
	"level" integer,
	"included_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"features" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "game_account_attributes_type" CHECK ("game_account_attributes"."account_type" ~ '^[A-Z][A-Z0-9_]{1,29}$'),
	CONSTRAINT "game_account_attributes_level" CHECK ("game_account_attributes"."level" is null or "game_account_attributes"."level" between 0 and 100000),
	CONSTRAINT "game_account_attributes_lists" CHECK (jsonb_typeof("game_account_attributes"."included_items") = 'array' and jsonb_typeof("game_account_attributes"."features") = 'array' and jsonb_array_length("game_account_attributes"."included_items") <= 50 and jsonb_array_length("game_account_attributes"."features") <= 30 and pg_column_size("game_account_attributes"."included_items") <= 8192 and pg_column_size("game_account_attributes"."features") <= 4096)
);
--> statement-breakpoint
CREATE TABLE "game_platform_regions" (
	"game_id" uuid NOT NULL,
	"platform_id" uuid NOT NULL,
	"region_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "game_platform_regions_pk" PRIMARY KEY("game_id","platform_id","region_id")
);
--> statement-breakpoint
CREATE TABLE "game_platforms" (
	"game_id" uuid NOT NULL,
	"platform_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "game_platforms_pk" PRIMARY KEY("game_id","platform_id")
);
--> statement-breakpoint
CREATE TABLE "games" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "games_slug_format" CHECK ("games"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length("games"."slug") <= 80),
	CONSTRAINT "games_name_len" CHECK (char_length(btrim("games"."name")) between 1 and 160),
	CONSTRAINT "games_status" CHECK ("games"."status" in ('ACTIVE','ARCHIVED'))
);
--> statement-breakpoint
CREATE TABLE "platforms" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "platforms_slug_format" CHECK ("platforms"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length("platforms"."slug") <= 80),
	CONSTRAINT "platforms_name_len" CHECK (char_length(btrim("platforms"."name")) between 1 and 120),
	CONSTRAINT "platforms_status" CHECK ("platforms"."status" in ('ACTIVE','ARCHIVED'))
);
--> statement-breakpoint
CREATE TABLE "variant_fulfillment_changes" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "variant_fulfillment_changes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"variant_id" uuid NOT NULL,
	"from_method" text NOT NULL,
	"to_method" text NOT NULL,
	"reason" text NOT NULL,
	"actor_id" text NOT NULL,
	"usage" jsonb NOT NULL,
	"txid" bigint DEFAULT txid_current() NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "variant_fulfillment_changes_methods" CHECK ("variant_fulfillment_changes"."from_method" in ('AUTO_CODE','MANUAL','SUPPLIER_API') and "variant_fulfillment_changes"."to_method" in ('AUTO_CODE','MANUAL','SUPPLIER_API') and "variant_fulfillment_changes"."from_method" <> "variant_fulfillment_changes"."to_method"),
	CONSTRAINT "variant_fulfillment_changes_reason" CHECK (char_length(btrim("variant_fulfillment_changes"."reason")) >= 10)
);
--> statement-breakpoint
ALTER TABLE "digital_codes" DROP CONSTRAINT "digital_codes_status";--> statement-breakpoint
ALTER TABLE "digital_codes" DROP CONSTRAINT "digital_codes_status_links";--> statement-breakpoint
ALTER TABLE "inventory_movements" DROP CONSTRAINT "inventory_movements_type";--> statement-breakpoint
ALTER TABLE "product_variants" ADD COLUMN "platform_id" uuid;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "game_id" uuid;--> statement-breakpoint
ALTER TABLE "digital_codes" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "inventory_batches" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "game_account_attributes" ADD CONSTRAINT "game_account_attributes_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_platform_regions" ADD CONSTRAINT "game_platform_regions_region_id_regions_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."regions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_platform_regions" ADD CONSTRAINT "game_platform_regions_gp_fk" FOREIGN KEY ("game_id","platform_id") REFERENCES "public"."game_platforms"("game_id","platform_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_platforms" ADD CONSTRAINT "game_platforms_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_platforms" ADD CONSTRAINT "game_platforms_platform_id_platforms_id_fk" FOREIGN KEY ("platform_id") REFERENCES "public"."platforms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_fulfillment_changes" ADD CONSTRAINT "variant_fulfillment_changes_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "games_slug_uq" ON "games" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "platforms_slug_uq" ON "platforms" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "variant_fulfillment_changes_variant_idx" ON "variant_fulfillment_changes" USING btree ("variant_id","id");--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_platform_id_platforms_id_fk" FOREIGN KEY ("platform_id") REFERENCES "public"."platforms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "digital_codes_expiry_idx" ON "digital_codes" USING btree ("expires_at") WHERE "digital_codes"."expires_at" is not null and "digital_codes"."status" in ('AVAILABLE','QUARANTINED');--> statement-breakpoint
ALTER TABLE "digital_codes" ADD CONSTRAINT "digital_codes_expired_has_expiry" CHECK ("digital_codes"."status" <> 'EXPIRED' or "digital_codes"."expires_at" is not null);--> statement-breakpoint
ALTER TABLE "digital_codes" ADD CONSTRAINT "digital_codes_status" CHECK ("digital_codes"."status" in ('AVAILABLE','RESERVED','SOLD','VOID','QUARANTINED','EXPIRED'));--> statement-breakpoint
ALTER TABLE "digital_codes" ADD CONSTRAINT "digital_codes_status_links" CHECK (("digital_codes"."status" = 'AVAILABLE' and "digital_codes"."reservation_id" is null and "digital_codes"."order_item_ref" is null and "digital_codes"."reserved_until" is null)
       or ("digital_codes"."status" = 'RESERVED' and "digital_codes"."reservation_id" is not null and "digital_codes"."order_item_ref" is null and "digital_codes"."reserved_until" is not null)
       or ("digital_codes"."status" = 'SOLD' and "digital_codes"."order_item_ref" is not null and "digital_codes"."sold_at" is not null)
       or ("digital_codes"."status" in ('VOID','QUARANTINED','EXPIRED')));--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_type" CHECK ("inventory_movements"."type" in ('IMPORT','RESERVE','RELEASE','EXPIRE','SELL','VOID','QUARANTINE','UNQUARANTINE','ADJUST','CODE_EXPIRE'));