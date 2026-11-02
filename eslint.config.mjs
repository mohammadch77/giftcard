import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([".next/**", "node_modules/**", "db/migrations/**", "docs/**", "next-env.d.ts", "coverage/**"]),
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
  {
    // process.env may be read only by the validated config module (and tooling scripts/tests).
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/platform/config/**"],
    rules: {
      "no-restricted-properties": [
        "error",
        { object: "process", property: "env", message: "Read configuration via @/platform/config (validated), not process.env." },
      ],
    },
  },
  {
    // Rial <-> Toman is converted ONLY in src/platform/money (D1). Block `/ 10` and `* 10` elsewhere.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/platform/money/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        { selector: "BinaryExpression[operator='/'][right.value=10]", message: "Unit conversion belongs in src/platform/money (Rial<->Toman)." },
        { selector: "BinaryExpression[operator='*'][right.value=10]", message: "Unit conversion belongs in src/platform/money (Rial<->Toman)." },
        { selector: "BinaryExpression[operator='*'][left.value=10]", message: "Unit conversion belongs in src/platform/money (Rial<->Toman)." },
        {
          selector: "CallExpression[callee.property.name='query'] > TemplateLiteral[expressions.length>0]",
          message: "Do not interpolate values into SQL strings. Use parameters ($1) or Drizzle sql`` templates.",
        },
      ],
    },
  },
  {
    // Financial modules run inside database transactions: no external I/O may be performed (rule 7).
    files: ["src/modules/ledger/**/*.ts", "src/modules/audit/**/*.ts"],
    rules: {
      "no-restricted-globals": ["error", { name: "fetch", message: "No external calls in ledger/audit code (they run inside DB transactions)." }],
      "no-restricted-imports": ["error", { patterns: ["node:http", "node:https", "node:http2", "node:net", "node:tls", "node:dgram", "node:dns", "undici", "http", "https", "net"] }],
    },
  },
  {
    // Inside src/platform/money only the SQL-interpolation rule applies (unit conversion lives there).
    files: ["src/platform/money/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.property.name='query'] > TemplateLiteral[expressions.length>0]",
          message: "Do not interpolate values into SQL strings. Use parameters ($1) or Drizzle sql`` templates.",
        },
      ],
    },
  },
  {
    files: ["scripts/**/*.ts", "tests/**/*.ts", "src/worker/**/*.ts"],
    rules: { "no-console": "off" },
  },
  {
    files: ["**/*.cjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
]);
