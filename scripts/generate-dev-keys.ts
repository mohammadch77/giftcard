import { randomBytes } from "node:crypto";

// Prints THROW-AWAY random development values to stdout. Nothing is written to disk.
// Use only for a local .env (gitignored). Never use these values anywhere but a developer machine.
const names = ["DEV_KEK_V1", "DEV_PEPPER_V1", "DEV_KEK_V2", "DEV_PEPPER_V2"];
console.log("# local development only — do not commit, do not reuse");
console.log("KEY_PROVIDER=dev");
for (const n of names) console.log(`${n}=${randomBytes(32).toString("base64")}`);
