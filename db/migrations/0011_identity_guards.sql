-- Identity guards (Phase 2b-3). Forward-only; touches only tables created in 0010.
-- Invariants enforced in the database (defence in depth behind the application):
--   * state machines (users, OTP challenges, TOTP enrolment, MFA recovery) via the platform engine
--   * set-once / immutable columns on credential-bearing tables
--   * authz_version bump on every role / role-permission change (cache invalidation key)
--   * roles may only be granted to STAFF users
-- SQLSTATEs: PI001 immutable/set-once violation, PI002 role target is not staff.

-- ---------------------------------------------------------------- state machines
INSERT INTO state_transition_rules (machine, from_status, to_status) VALUES
  ('user_status', NULL, 'ACTIVE'),
  ('user_status', 'ACTIVE', 'SUSPENDED'),
  ('user_status', 'SUSPENDED', 'ACTIVE'),
  ('user_status', 'ACTIVE', 'CLOSED'),
  ('user_status', 'SUSPENDED', 'CLOSED'),
  ('otp_challenge', NULL, 'PENDING'),
  ('otp_challenge', 'PENDING', 'SENT'),
  ('otp_challenge', 'PENDING', 'FAILED'),
  ('otp_challenge', 'PENDING', 'CONSUMED'),
  ('otp_challenge', 'PENDING', 'SUPERSEDED'),
  ('otp_challenge', 'PENDING', 'LOCKED'),
  ('otp_challenge', 'SENT', 'CONSUMED'),
  ('otp_challenge', 'SENT', 'SUPERSEDED'),
  ('otp_challenge', 'SENT', 'LOCKED'),
  ('admin_totp', NULL, 'PENDING'),
  ('admin_totp', 'PENDING', 'ACTIVE'),
  ('admin_totp', 'PENDING', 'REPLACED'),
  ('admin_totp', 'ACTIVE', 'REPLACED'),
  ('mfa_recovery', NULL, 'REQUESTED'),
  ('mfa_recovery', 'REQUESTED', 'APPROVED'),
  ('mfa_recovery', 'REQUESTED', 'REJECTED'),
  ('mfa_recovery', 'REQUESTED', 'EXPIRED'),
  ('mfa_recovery', 'APPROVED', 'COMPLETED'),
  ('mfa_recovery', 'APPROVED', 'REJECTED'),
  ('mfa_recovery', 'APPROVED', 'EXPIRED');
--> statement-breakpoint
SELECT platform_attach_transition_guard('users', 'user_status', 'user_status_history', 'id', 'status', true);
--> statement-breakpoint
SELECT platform_attach_transition_guard('otp_challenges', 'otp_challenge');
--> statement-breakpoint
SELECT platform_attach_transition_guard('admin_totp', 'admin_totp');
--> statement-breakpoint
SELECT platform_attach_transition_guard('mfa_recovery_requests', 'mfa_recovery', 'mfa_recovery_history', 'id', 'status', true);
--> statement-breakpoint

-- ---------------------------------------------------------------- immutability helpers
CREATE FUNCTION identity_forbid_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
DECLARE c text;
BEGIN
  FOREACH c IN ARRAY TG_ARGV LOOP
    IF to_jsonb(OLD) -> c IS DISTINCT FROM to_jsonb(NEW) -> c THEN
      RAISE EXCEPTION 'column %.% is immutable', TG_TABLE_NAME, c USING ERRCODE = 'PI001';
    END IF;
  END LOOP;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint
CREATE FUNCTION identity_set_once() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
DECLARE c text;
BEGIN
  FOREACH c IN ARRAY TG_ARGV LOOP
    IF (to_jsonb(OLD) -> c) <> 'null'::jsonb AND to_jsonb(OLD) -> c IS DISTINCT FROM to_jsonb(NEW) -> c THEN
      RAISE EXCEPTION 'column %.% is set-once', TG_TABLE_NAME, c USING ERRCODE = 'PI001';
    END IF;
  END LOOP;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint
CREATE TRIGGER users_immutable BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION identity_forbid_change('id', 'kind', 'created_at');
--> statement-breakpoint
CREATE TRIGGER user_identities_immutable BEFORE UPDATE ON user_identities
  FOR EACH ROW EXECUTE FUNCTION identity_forbid_change('id', 'user_id', 'type', 'value', 'created_at');
--> statement-breakpoint
CREATE TRIGGER user_identities_verified_once BEFORE UPDATE ON user_identities
  FOR EACH ROW EXECUTE FUNCTION identity_set_once('verified_at');
--> statement-breakpoint
CREATE TRIGGER otp_challenges_immutable BEFORE UPDATE ON otp_challenges
  FOR EACH ROW EXECUTE FUNCTION identity_forbid_change('id', 'phone', 'code_digest', 'hmac_version', 'max_attempts', 'created_at', 'expires_at', 'purpose');
--> statement-breakpoint
CREATE TRIGGER otp_challenges_consumed_once BEFORE UPDATE ON otp_challenges
  FOR EACH ROW EXECUTE FUNCTION identity_set_once('consumed_at', 'sent_at');
--> statement-breakpoint
CREATE TRIGGER user_sessions_immutable BEFORE UPDATE ON user_sessions
  FOR EACH ROW EXECUTE FUNCTION identity_forbid_change('id', 'user_id', 'created_at', 'idle_seconds', 'absolute_expires_at', 'ip_prefix', 'user_agent');
--> statement-breakpoint
CREATE TRIGGER user_sessions_revoked_once BEFORE UPDATE ON user_sessions
  FOR EACH ROW EXECUTE FUNCTION identity_set_once('revoked_at', 'revoked_reason');
--> statement-breakpoint
-- A revoked session can never be revived or re-keyed.
CREATE FUNCTION identity_session_no_revive() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF OLD.revoked_at IS NOT NULL AND (NEW.token_digest IS DISTINCT FROM OLD.token_digest
     OR NEW.mfa_verified_at IS DISTINCT FROM OLD.mfa_verified_at OR NEW.step_up_at IS DISTINCT FROM OLD.step_up_at
     OR NEW.idle_expires_at IS DISTINCT FROM OLD.idle_expires_at OR NEW.last_seen_at IS DISTINCT FROM OLD.last_seen_at) THEN
    RAISE EXCEPTION 'a revoked session cannot be modified' USING ERRCODE = 'PI001';
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint
CREATE TRIGGER user_sessions_no_revive BEFORE UPDATE ON user_sessions
  FOR EACH ROW EXECUTE FUNCTION identity_session_no_revive();
--> statement-breakpoint
CREATE TRIGGER admin_totp_immutable BEFORE UPDATE ON admin_totp
  FOR EACH ROW EXECUTE FUNCTION identity_forbid_change('id', 'user_id', 'secret_sealed', 'created_at');
--> statement-breakpoint
CREATE TRIGGER admin_totp_set_once BEFORE UPDATE ON admin_totp
  FOR EACH ROW EXECUTE FUNCTION identity_set_once('confirmed_at', 'replaced_at');
--> statement-breakpoint
CREATE TRIGGER admin_recovery_codes_immutable BEFORE UPDATE ON admin_recovery_codes
  FOR EACH ROW EXECUTE FUNCTION identity_forbid_change('id', 'user_id', 'batch_id', 'code_digest', 'hmac_version', 'created_at');
--> statement-breakpoint
CREATE TRIGGER admin_recovery_codes_set_once BEFORE UPDATE ON admin_recovery_codes
  FOR EACH ROW EXECUTE FUNCTION identity_set_once('used_at', 'superseded_at');
--> statement-breakpoint
CREATE TRIGGER mfa_recovery_immutable BEFORE UPDATE ON mfa_recovery_requests
  FOR EACH ROW EXECUTE FUNCTION identity_forbid_change('id', 'target_user_id', 'requested_by', 'reason', 'created_at');
--> statement-breakpoint
CREATE TRIGGER mfa_recovery_set_once BEFORE UPDATE ON mfa_recovery_requests
  FOR EACH ROW EXECUTE FUNCTION identity_set_once('approved_by', 'approval_reason', 'approved_at', 'approval_expires_at', 'completed_by', 'completed_at');
--> statement-breakpoint
CREATE TRIGGER roles_immutable BEFORE UPDATE ON roles
  FOR EACH ROW EXECUTE FUNCTION identity_forbid_change('id', 'name', 'is_system', 'created_at');
--> statement-breakpoint
CREATE TRIGGER role_permissions_immutable BEFORE UPDATE ON role_permissions
  FOR EACH ROW EXECUTE FUNCTION identity_forbid_change('id', 'role_id', 'permission', 'granted_by', 'granted_at');
--> statement-breakpoint
CREATE TRIGGER role_permissions_revoked_once BEFORE UPDATE ON role_permissions
  FOR EACH ROW EXECUTE FUNCTION identity_set_once('revoked_at', 'revoked_by');
--> statement-breakpoint
CREATE TRIGGER user_roles_immutable BEFORE UPDATE ON user_roles
  FOR EACH ROW EXECUTE FUNCTION identity_forbid_change('id', 'user_id', 'role_id', 'granted_by', 'granted_at');
--> statement-breakpoint
CREATE TRIGGER user_roles_revoked_once BEFORE UPDATE ON user_roles
  FOR EACH ROW EXECUTE FUNCTION identity_set_once('revoked_at', 'revoked_by');
--> statement-breakpoint

-- ---------------------------------------------------------------- RBAC invariants
CREATE FUNCTION identity_user_role_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
DECLARE v_kind text;
BEGIN
  SELECT kind INTO v_kind FROM public.users WHERE id = NEW.user_id;
  IF v_kind IS DISTINCT FROM 'STAFF' THEN
    RAISE EXCEPTION 'roles can only be granted to staff users' USING ERRCODE = 'PI002';
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint
CREATE TRIGGER user_roles_staff_only BEFORE INSERT ON user_roles
  FOR EACH ROW EXECUTE FUNCTION identity_user_role_guard();
--> statement-breakpoint

-- authz_version is bumped ONLY here (SECURITY DEFINER): the application role has no UPDATE on it.
CREATE FUNCTION identity_bump_authz_for_user() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  UPDATE public.users SET authz_version = authz_version + 1 WHERE id = NEW.user_id;
  RETURN NULL;
END
$fn$;
--> statement-breakpoint
CREATE FUNCTION identity_bump_authz_for_role() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  UPDATE public.users SET authz_version = authz_version + 1
   WHERE id IN (SELECT user_id FROM public.user_roles WHERE role_id = NEW.role_id AND revoked_at IS NULL);
  RETURN NULL;
END
$fn$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION identity_bump_authz_for_user() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION identity_bump_authz_for_role() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER user_roles_bump_authz AFTER INSERT OR UPDATE ON user_roles
  FOR EACH ROW EXECUTE FUNCTION identity_bump_authz_for_user();
--> statement-breakpoint
CREATE TRIGGER role_permissions_bump_authz AFTER INSERT OR UPDATE ON role_permissions
  FOR EACH ROW EXECUTE FUNCTION identity_bump_authz_for_role();
--> statement-breakpoint

-- ---------------------------------------------------------------- seed system roles (explicit lists, no wildcard)
INSERT INTO roles (id, name, description, is_system, created_at) VALUES
  ('0192a000-0000-7000-8000-000000000001', 'owner', 'Full access to every permission registered at seed time', true, now()),
  ('0192a000-0000-7000-8000-000000000002', 'security_admin', 'Identity and security administration, role management, MFA recovery', true, now()),
  ('0192a000-0000-7000-8000-000000000003', 'support_agent', 'Limited customer identity read access (masked)', true, now());
--> statement-breakpoint
INSERT INTO role_permissions (id, role_id, permission, granted_by, granted_at)
SELECT gen_random_uuid(), r.id, p.permission, NULL, now()
  FROM (VALUES
    ('owner', 'identity.users.read'), ('owner', 'identity.users.read_unmasked'), ('owner', 'identity.users.suspend'),
    ('owner', 'identity.staff.manage'), ('owner', 'identity.roles.manage'), ('owner', 'identity.sessions.revoke'), ('owner', 'identity.mfa.reset'),
    ('security_admin', 'identity.users.read'), ('security_admin', 'identity.users.read_unmasked'), ('security_admin', 'identity.users.suspend'),
    ('security_admin', 'identity.staff.manage'), ('security_admin', 'identity.roles.manage'), ('security_admin', 'identity.sessions.revoke'),
    ('security_admin', 'identity.mfa.reset'),
    ('support_agent', 'identity.users.read')
  ) AS p(role_name, permission)
  JOIN roles r ON r.name = p.role_name;
--> statement-breakpoint

-- ---------------------------------------------------------------- grants (least privilege; no DELETE anywhere)
SELECT platform_register_grants('rate_limit_counters', 'append_only', ARRAY['count']);
--> statement-breakpoint
SELECT platform_register_grants('users', 'append_only', ARRAY['status', 'updated_at']);
--> statement-breakpoint
SELECT platform_register_grants('user_status_history', 'append_only');
--> statement-breakpoint
SELECT platform_register_grants('user_identities', 'append_only', ARRAY['verified_at']);
--> statement-breakpoint
SELECT platform_register_grants('otp_challenges', 'append_only', ARRAY['status', 'attempts', 'sent_at', 'consumed_at']);
--> statement-breakpoint
SELECT platform_register_grants('user_sessions', 'append_only',
  ARRAY['last_seen_at', 'idle_expires_at', 'revoked_at', 'revoked_reason', 'mfa_verified_at', 'mfa_method', 'step_up_at', 'token_digest']);
--> statement-breakpoint
SELECT platform_register_grants('roles', 'append_only');
--> statement-breakpoint
SELECT platform_register_grants('role_permissions', 'append_only', ARRAY['revoked_at', 'revoked_by']);
--> statement-breakpoint
SELECT platform_register_grants('user_roles', 'append_only', ARRAY['revoked_at', 'revoked_by']);
--> statement-breakpoint
SELECT platform_register_grants('admin_totp', 'append_only', ARRAY['status', 'last_used_step', 'confirmed_at', 'replaced_at']);
--> statement-breakpoint
SELECT platform_register_grants('admin_recovery_codes', 'append_only', ARRAY['used_at', 'superseded_at']);
--> statement-breakpoint
SELECT platform_register_grants('mfa_recovery_requests', 'append_only',
  ARRAY['status', 'approved_by', 'approval_reason', 'approved_at', 'approval_expires_at', 'completed_by', 'completed_at']);
--> statement-breakpoint
SELECT platform_register_grants('mfa_recovery_history', 'append_only');
