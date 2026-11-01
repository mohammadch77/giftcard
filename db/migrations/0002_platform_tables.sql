CREATE TABLE "idempotency_keys" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "idempotency_keys_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "idempotency_keys_scope_key" UNIQUE("scope","key"),
	CONSTRAINT "idempotency_keys_scope_format" CHECK ("idempotency_keys"."scope" ~ '^[a-z][a-z0-9_.:-]{0,63}$'),
	CONSTRAINT "idempotency_keys_key_format" CHECK ("idempotency_keys"."key" ~ '^[A-Za-z0-9_.:-]{8,128}$'),
	CONSTRAINT "idempotency_keys_hash_format" CHECK ("idempotency_keys"."request_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "state_transition_rules" (
	"machine" text NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "state_transition_rules_machine_format" CHECK ("state_transition_rules"."machine" ~ '^[a-z][a-z0-9_]*$'),
	CONSTRAINT "state_transition_rules_distinct" CHECK ("state_transition_rules"."from_status" IS DISTINCT FROM "state_transition_rules"."to_status")
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "outbox_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"event_type" text NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 10 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_by" text,
	"locked_until" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_events_status" CHECK ("outbox_events"."status" IN ('PENDING','PROCESSING','DONE','DEAD')),
	CONSTRAINT "outbox_events_attempts" CHECK ("outbox_events"."attempts" >= 0 AND "outbox_events"."max_attempts" >= 1),
	CONSTRAINT "outbox_events_type_format" CHECK ("outbox_events"."event_type" ~ '^[a-z][a-z0-9_.]*$' AND "outbox_events"."aggregate_type" ~ '^[a-z][a-z0-9_]*$'),
	CONSTRAINT "outbox_events_lease_consistent" CHECK (("outbox_events"."status" = 'PROCESSING') = ("outbox_events"."locked_by" IS NOT NULL AND "outbox_events"."locked_until" IS NOT NULL)),
	CONSTRAINT "outbox_events_done_has_time" CHECK (("outbox_events"."status" = 'DONE') = ("outbox_events"."processed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "platform_grant_registry" (
	"table_name" text PRIMARY KEY NOT NULL,
	"mode" text NOT NULL,
	"update_columns" text[],
	CONSTRAINT "platform_grant_registry_mode" CHECK ("platform_grant_registry"."mode" IN ('append_only','read_only','read_write','read_write_delete'))
);
--> statement-breakpoint
CREATE TABLE "platform_roles" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"app_role" text DEFAULT 'giftcard_app' NOT NULL,
	"readonly_role" text DEFAULT 'giftcard_readonly' NOT NULL,
	CONSTRAINT "platform_roles_singleton" CHECK ("platform_roles"."singleton"),
	CONSTRAINT "platform_roles_names" CHECK ("platform_roles"."app_role" ~ '^[a-z][a-z0-9_]{0,62}$' AND "platform_roles"."readonly_role" ~ '^[a-z][a-z0-9_]{0,62}$' AND "platform_roles"."app_role" <> "platform_roles"."readonly_role")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "state_transition_rules_unique" ON "state_transition_rules" USING btree ("machine",coalesce("from_status", ''),"to_status");--> statement-breakpoint
CREATE INDEX "state_transition_rules_lookup" ON "state_transition_rules" USING btree ("machine","from_status");--> statement-breakpoint
CREATE INDEX "outbox_events_claim_pending" ON "outbox_events" USING btree ("available_at","id") WHERE "outbox_events"."status" = 'PENDING';--> statement-breakpoint
CREATE INDEX "outbox_events_claim_expired" ON "outbox_events" USING btree ("locked_until") WHERE "outbox_events"."status" = 'PROCESSING';--> statement-breakpoint
CREATE INDEX "outbox_events_aggregate" ON "outbox_events" USING btree ("aggregate_type","aggregate_id");