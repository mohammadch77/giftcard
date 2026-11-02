CREATE TABLE "rate_limit_counters" (
	"bucket" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "rate_limit_counters_bucket_window_start_pk" PRIMARY KEY("bucket","window_start"),
	CONSTRAINT "rate_limit_counters_bucket_len" CHECK (char_length("rate_limit_counters"."bucket") between 1 and 200),
	CONSTRAINT "rate_limit_counters_count_nonneg" CHECK ("rate_limit_counters"."count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "admin_recovery_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"code_digest" "bytea" NOT NULL,
	"hmac_version" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	CONSTRAINT "admin_recovery_codes_digest_len" CHECK (octet_length("admin_recovery_codes"."code_digest") = 32)
);
--> statement-breakpoint
CREATE TABLE "admin_totp" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"secret_sealed" "bytea" NOT NULL,
	"last_used_step" bigint,
	"created_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone,
	"replaced_at" timestamp with time zone,
	CONSTRAINT "admin_totp_status_valid" CHECK ("admin_totp"."status" in ('PENDING','ACTIVE','REPLACED'))
);
--> statement-breakpoint
CREATE TABLE "mfa_recovery_history" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "mfa_recovery_history_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"entity_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"actor_id" text,
	"reason" text,
	"occurred_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mfa_recovery_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"target_user_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'REQUESTED' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"approved_by" uuid,
	"approval_reason" text,
	"approved_at" timestamp with time zone,
	"approval_expires_at" timestamp with time zone,
	"completed_by" uuid,
	"completed_at" timestamp with time zone,
	CONSTRAINT "mfa_recovery_status_valid" CHECK ("mfa_recovery_requests"."status" in ('REQUESTED','APPROVED','COMPLETED','REJECTED','EXPIRED')),
	CONSTRAINT "mfa_recovery_reason_len" CHECK (char_length(btrim("mfa_recovery_requests"."reason")) >= 10),
	CONSTRAINT "mfa_recovery_not_self_requested" CHECK ("mfa_recovery_requests"."requested_by" <> "mfa_recovery_requests"."target_user_id"),
	CONSTRAINT "mfa_recovery_independent_approver" CHECK ("mfa_recovery_requests"."approved_by" is null or ("mfa_recovery_requests"."approved_by" <> "mfa_recovery_requests"."requested_by" and "mfa_recovery_requests"."approved_by" <> "mfa_recovery_requests"."target_user_id")),
	CONSTRAINT "mfa_recovery_approval_reason" CHECK ("mfa_recovery_requests"."approved_by" is null or char_length(btrim(coalesce("mfa_recovery_requests"."approval_reason", ''))) >= 10),
	CONSTRAINT "mfa_recovery_approved_fields" CHECK ("mfa_recovery_requests"."status" not in ('APPROVED','COMPLETED') or ("mfa_recovery_requests"."approved_by" is not null and "mfa_recovery_requests"."approved_at" is not null and "mfa_recovery_requests"."approval_expires_at" is not null)),
	CONSTRAINT "mfa_recovery_completed_fields" CHECK ("mfa_recovery_requests"."status" <> 'COMPLETED' or ("mfa_recovery_requests"."completed_by" is not null and "mfa_recovery_requests"."completed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "otp_challenges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"purpose" text DEFAULT 'LOGIN' NOT NULL,
	"phone" text NOT NULL,
	"code_digest" "bytea" NOT NULL,
	"hmac_version" integer NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "otp_challenges_status_valid" CHECK ("otp_challenges"."status" in ('PENDING','SENT','CONSUMED','SUPERSEDED','FAILED','LOCKED')),
	CONSTRAINT "otp_challenges_phone_e164" CHECK ("otp_challenges"."phone" ~ '^\+989[0-9]{9}$'),
	CONSTRAINT "otp_challenges_digest_len" CHECK (octet_length("otp_challenges"."code_digest") = 32),
	CONSTRAINT "otp_challenges_attempts" CHECK ("otp_challenges"."attempts" >= 0 and "otp_challenges"."max_attempts" between 1 and 10)
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"role_id" uuid NOT NULL,
	"permission" text NOT NULL,
	"granted_by" uuid,
	"granted_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	CONSTRAINT "role_permissions_format" CHECK ("role_permissions"."permission" ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$')
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "roles_name_format" CHECK ("roles"."name" ~ '^[a-z][a-z0-9_]{1,62}$')
);
--> statement-breakpoint
CREATE TABLE "user_identities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"value" text NOT NULL,
	"is_primary" boolean DEFAULT true NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "user_identities_type_valid" CHECK ("user_identities"."type" in ('PHONE')),
	CONSTRAINT "user_identities_phone_e164" CHECK ("user_identities"."type" <> 'PHONE' or "user_identities"."value" ~ '^\+989[0-9]{9}$')
);
--> statement-breakpoint
CREATE TABLE "user_roles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"granted_by" uuid,
	"granted_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	CONSTRAINT "user_roles_no_self_grant" CHECK ("user_roles"."granted_by" is null or "user_roles"."granted_by" <> "user_roles"."user_id")
);
--> statement-breakpoint
CREATE TABLE "user_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_digest" "bytea" NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"idle_seconds" integer NOT NULL,
	"idle_expires_at" timestamp with time zone NOT NULL,
	"absolute_expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"mfa_verified_at" timestamp with time zone,
	"mfa_method" text,
	"step_up_at" timestamp with time zone,
	"ip_prefix" text,
	"user_agent" text,
	CONSTRAINT "user_sessions_digest_len" CHECK (octet_length("user_sessions"."token_digest") = 32),
	CONSTRAINT "user_sessions_mfa_method" CHECK ("user_sessions"."mfa_method" is null or "user_sessions"."mfa_method" in ('TOTP','RECOVERY_CODE')),
	CONSTRAINT "user_sessions_expiry_order" CHECK ("user_sessions"."absolute_expires_at" > "user_sessions"."created_at")
);
--> statement-breakpoint
CREATE TABLE "user_status_history" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "user_status_history_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"entity_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"actor_id" text,
	"reason" text,
	"occurred_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"authz_version" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "users_kind_valid" CHECK ("users"."kind" in ('CUSTOMER','STAFF')),
	CONSTRAINT "users_status_valid" CHECK ("users"."status" in ('ACTIVE','SUSPENDED','CLOSED'))
);
--> statement-breakpoint
ALTER TABLE "admin_recovery_codes" ADD CONSTRAINT "admin_recovery_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_totp" ADD CONSTRAINT "admin_totp_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mfa_recovery_requests" ADD CONSTRAINT "mfa_recovery_requests_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mfa_recovery_requests" ADD CONSTRAINT "mfa_recovery_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mfa_recovery_requests" ADD CONSTRAINT "mfa_recovery_requests_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mfa_recovery_requests" ADD CONSTRAINT "mfa_recovery_requests_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_recovery_codes_digest_uq" ON "admin_recovery_codes" USING btree ("hmac_version","code_digest");--> statement-breakpoint
CREATE INDEX "admin_recovery_codes_user_open_idx" ON "admin_recovery_codes" USING btree ("user_id") WHERE "admin_recovery_codes"."used_at" is null and "admin_recovery_codes"."superseded_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_totp_active_uq" ON "admin_totp" USING btree ("user_id") WHERE "admin_totp"."status" = 'ACTIVE';--> statement-breakpoint
CREATE UNIQUE INDEX "admin_totp_pending_uq" ON "admin_totp" USING btree ("user_id") WHERE "admin_totp"."status" = 'PENDING';--> statement-breakpoint
CREATE UNIQUE INDEX "mfa_recovery_open_uq" ON "mfa_recovery_requests" USING btree ("target_user_id") WHERE "mfa_recovery_requests"."status" in ('REQUESTED','APPROVED');--> statement-breakpoint
CREATE UNIQUE INDEX "otp_challenges_active_phone_uq" ON "otp_challenges" USING btree ("phone") WHERE "otp_challenges"."status" in ('PENDING','SENT');--> statement-breakpoint
CREATE INDEX "otp_challenges_phone_created_idx" ON "otp_challenges" USING btree ("phone","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "otp_challenges_expires_idx" ON "otp_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "role_permissions_active_uq" ON "role_permissions" USING btree ("role_id","permission") WHERE "role_permissions"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "roles_name_uq" ON "roles" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "user_identities_type_value_uq" ON "user_identities" USING btree ("type","value");--> statement-breakpoint
CREATE UNIQUE INDEX "user_identities_primary_uq" ON "user_identities" USING btree ("user_id","type") WHERE "user_identities"."is_primary";--> statement-breakpoint
CREATE UNIQUE INDEX "user_roles_active_uq" ON "user_roles" USING btree ("user_id","role_id") WHERE "user_roles"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "user_roles_role_active_idx" ON "user_roles" USING btree ("role_id") WHERE "user_roles"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "user_sessions_token_digest_uq" ON "user_sessions" USING btree ("token_digest");--> statement-breakpoint
CREATE INDEX "user_sessions_user_active_idx" ON "user_sessions" USING btree ("user_id") WHERE "user_sessions"."revoked_at" is null;