// Read-only check of the store credentials (Google Play service account, Apple In-App Purchase key) with the backend's own settings
// rules. Logic (the exported `run`): src/purchases/stores-check.ts (built to dist/). It sends no purchase write, no acknowledge and touches no database.
//
// Local: `npm run stores:check` (it builds first). Pass a real FIREBASE_PROJECT_ID inline for this run (the store settings are refused
// with a demo- project). Server: `node scripts/stores-check.mjs` from a deployed checkout with dist/ present, as the app user (never
// root). It reads `.env` from the working directory when there is one; variables already set win. Prints statuses, reason strings and
// product ids only: never a token, key, key contents or JWT. Exit 0 only if every configured store passes.
import { run } from "../dist/purchases/stores-check.js";

try {
  process.loadEnvFile(".env");
} catch {
  // No .env file: the real environment is the only source.
}
const { code, lines } = await run(process.env, (input, init) => fetch(input, init));
for (const line of lines) console.log(line);
process.exitCode = code;
