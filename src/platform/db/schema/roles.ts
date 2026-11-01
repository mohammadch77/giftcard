import { sql } from "drizzle-orm";
import { boolean, check, pgTable, text } from "drizzle-orm/pg-core";

/**
 * Names of the application database roles (P-4). Roles are created by the ops script
 * db/ops/roles.sql, never by migrations. A singleton row lets tests use unique role names
 * (PostgreSQL roles are cluster-global).
 */
export const platformRoles = pgTable(
  "platform_roles",
  {
    singleton: boolean("singleton").primaryKey().default(true),
    appRole: text("app_role").notNull().default("giftcard_app"),
    readonlyRole: text("readonly_role").notNull().default("giftcard_readonly"),
  },
  (t) => [
    check("platform_roles_singleton", sql`${t.singleton}`),
    check("platform_roles_names", sql`${t.appRole} ~ '^[a-z][a-z0-9_]{0,62}$' AND ${t.readonlyRole} ~ '^[a-z][a-z0-9_]{0,62}$' AND ${t.appRole} <> ${t.readonlyRole}`),
  ],
);

/** Every application table must be registered with a grant mode (see platform_register_grants). */
export const platformGrantRegistry = pgTable(
  "platform_grant_registry",
  {
    tableName: text("table_name").primaryKey(),
    mode: text("mode").notNull(),
    updateColumns: text("update_columns").array(),
  },
  (t) => [check("platform_grant_registry_mode", sql`${t.mode} IN ('append_only','read_only','read_write','read_write_delete')`)],
);
