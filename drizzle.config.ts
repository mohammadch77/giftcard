import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: ["./src/platform/db/schema/*.ts", "./src/modules/*/infra/schema.ts"],
  out: "./db/migrations",
  strict: true,
  verbose: true,
});
