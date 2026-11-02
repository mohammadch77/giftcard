-- Audit trail guards (step 2b-2). audit_logs is append-only evidence.
CREATE TRIGGER audit_logs_no_mutation BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION platform_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION platform_reject_mutation();
--> statement-breakpoint
SELECT platform_register_grants('audit_logs', 'append_only');
