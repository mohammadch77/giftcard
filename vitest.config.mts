import path from "node:path";
import { defineConfig } from "vitest/config";

// Load a local, gitignored .env for developer runs (CI injects variables directly).
try {
  process.loadEnvFile(path.resolve(import.meta.dirname, ".env"));
} catch {
  /* no .env file: rely on the real environment */
}

const alias = { "@": path.resolve(import.meta.dirname, "src") };

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: { name: "unit", include: ["tests/unit/**/*.test.ts", "tests/architecture/**/*.test.ts"], environment: "node" },
      },
      {
        resolve: { alias },
        test: {
          name: "db",
          include: ["tests/db/**/*.test.ts"],
          environment: "node",
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
