-- Operational script (NOT a migration): create the application database roles, then apply grants.
-- Run once per cluster by a DBA/superuser; re-running is safe. No passwords are set here — an operator
-- gives each role LOGIN and a password out-of-band (never commit credentials), e.g.:
--     ALTER ROLE giftcard_app LOGIN PASSWORD '<set-by-operator>';
-- Role names must match the singleton row in platform_roles (defaults below).
--   giftcard_app       runtime role of the web app and the worker (DML only, see platform_register_grants)
--   giftcard_readonly  reporting / support read-only role
-- The migrator role is the database owner (or a superuser); it is NOT created here.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'giftcard_app') THEN
    CREATE ROLE giftcard_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'giftcard_readonly') THEN
    CREATE ROLE giftcard_readonly NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;

SELECT platform_apply_grants();
