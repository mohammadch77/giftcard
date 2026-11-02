/** Module-boundary rules for the modular monolith (see docs/ARCHITECTURE.md §3). */
const allowed = require("./architecture/module-deps.cjs");

const moduleRules = Object.entries(allowed).map(([mod, deps]) => ({
  name: `module-dependency-matrix:${mod}`,
  comment: `${mod} may only import: ${deps.join(", ") || "(no other module)"}`,
  severity: "error",
  from: { path: `^src/modules/${mod}/` },
  to: { path: `^src/modules/(?!(${[mod, ...deps].join("|")})/)[^/]+/` },
}));

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-module-internals-from-other-modules",
      comment: "Other modules may import only a module's index.ts, never domain/application/infra.",
      severity: "error",
      from: { path: "^src/modules/([^/]+)/" },
      to: { path: "^src/modules/[^/]+/(domain|application|infra)/", pathNot: "^src/modules/$1/" },
    },
    {
      name: "no-module-internals-from-outside-modules",
      comment: "app/, worker/, platform/, ui/ may import only a module's index.ts.",
      severity: "error",
      from: { path: "^src/(app|worker|platform|ui)/" },
      to: { path: "^src/modules/[^/]+/(domain|application|infra)/" },
    },
    {
      name: "platform-is-domain-free",
      comment: "platform/ is shared infrastructure and must not import business modules.",
      severity: "error",
      from: { path: "^src/platform/" },
      to: { path: "^src/modules/" },
    },
    {
      name: "ui-is-presentational",
      comment: "ui/ must not import business modules, the DB layer or config.",
      severity: "error",
      from: { path: "^src/ui/" },
      to: { path: "^src/(modules|platform/db|platform/config)/" },
    },
    {
      name: "app-has-no-direct-db-access",
      comment: "Routes/pages call use cases; they never touch platform/db directly.",
      severity: "error",
      from: { path: "^src/app/" },
      to: { path: "^src/platform/db/" },
    },
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "src-must-not-import-tests-or-scripts",
      severity: "error",
      from: { path: "^src/" },
      to: { path: "^(tests|scripts)/" },
    },
    {
      name: "not-to-dev-dependency",
      comment: "Production code must not depend on devDependencies.",
      severity: "error",
      from: { path: "^src/" },
      to: { dependencyTypes: ["npm-dev"] },
    },
    {
      name: "no-testing-doubles-in-production",
      comment: "Test/dev doubles live in a testing/ folder or a testing.ts file and may only be used by tests and by the guarded factory in src/platform/composition (P-5).",
      severity: "error",
      from: { path: "^src/", pathNot: "(^|/)testing(/|\\.[cm]?tsx?$)|^src/platform/composition/" },
      to: { path: "(^|/)testing(/|\\.[cm]?tsx?$)" },
    },
    {
      name: "not-to-unresolvable",
      severity: "error",
      from: {},
      to: { couldNotResolve: true },
    },
    ...moduleRules,
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "require", "node", "default", "types"] },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
