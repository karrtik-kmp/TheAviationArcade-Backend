// First admin and recovery: grant the `admin` role to one Firebase uid with the backend's own compiled RoleStore, so the role
// lock, the revision bump and the audit row are the same code as the API grant (Backend ADR-0002, plan R-c).
//
// Run `npm run roles:grant -- <uid> --yes` (it builds first). It writes ONLY when NO active admin exists (checked inside the same
// locked transaction as the grant) and when the target database was shown and --yes was given. It builds the principal
// `firebase:<FIREBASE_PROJECT_ID>:<uid>`; it never prints the database password.
//
// Exit codes: 0 granted; 1 unexpected failure (database unreachable, ...), nothing is known to be written; 2 refused because
// of the arguments or settings (nothing was contacted); 3 refused by the database state (an active admin exists, ...).
import { userInfo } from "node:os";

try {
  process.loadEnvFile(".env");
} catch {
  // No .env file: the real environment is the only source.
}

const refuse = (message, code = 2) => {
  console.error(`${message} Nothing was written.`);
  process.exit(code);
};

const usage = "Usage: npm run roles:grant -- <uid> [--role admin] --yes";
const args = process.argv.slice(2);
const positionals = [];
let confirmed = false;
let role = "admin";
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--yes") confirmed = true;
  else if (arg === "--role") role = args[(i += 1)] ?? "";
  else if (arg.startsWith("--role=")) role = arg.slice("--role=".length);
  else if (arg.startsWith("--")) refuse(`Unknown option ${arg}. ${usage}.`);
  else positionals.push(arg);
}
if (role !== "admin") refuse(`Only the admin role can be granted here (got "${role}"); photographers go through request and approval.`);
if (positionals.length !== 1) refuse(`Give exactly one uid. ${usage}.`);

// The server's own loader: same validation as the API (TLS rules, demo project in production, DATABASE_URL ssl params, CA cert).
// It also checks settings this script does not use (BLOB_STORE, UGS_*, ...), so a broken server setting refuses here too.
// Its messages name variables, never values.
const { loadConfig } = await import("../dist/config/config.module.js");
let config;
try {
  config = loadConfig(process.env);
} catch (error) {
  refuse(error instanceof Error ? error.message : "Invalid environment configuration.");
}
const projectId = config.firebaseProjectId;
const appEnv = config.appEnv;

const { accountPrincipalFor, uidOfAccountPrincipal } = await import("../dist/accounts/account-principal.js");
const target = positionals[0];
let principal;
if (target.startsWith("firebase:")) {
  // A full principal is accepted only for the configured project.
  principal = uidOfAccountPrincipal(target, projectId) === undefined ? undefined : target;
  if (principal === undefined) refuse(`"${target}" is not a valid principal of the configured project ${projectId}.`);
} else {
  principal = accountPrincipalFor(target, projectId);
  if (principal === undefined) refuse("That is not a valid uid (1-128 characters, no surrounding whitespace, no ':' or '/', no control characters).");
}

let host;
let port;
let database;
try {
  const { default: parseConnectionString } = await import("pg-connection-string");
  const parsed = parseConnectionString.parse(config.databaseUrl);
  host = parsed.host ?? "(default socket)";
  port = parsed.port ?? "(default)";
  database = parsed.database ?? "(none)";
} catch {
  refuse("DATABASE_URL could not be parsed.");
}
console.log(`Target database: host ${host}, port ${port}, database ${database} (APP_ENV=${appEnv}).`);
console.log(`Grant admin to ${principal}.`);
if (!confirmed) refuse("Add --yes to confirm this is the right database and account.");

const { default: pg } = await import("pg");
const { DatabaseService, poolOptions } = await import("../dist/database/database.module.js");
const { RoleStore } = await import("../dist/accounts/role-store.js");

const pool = new pg.Pool(poolOptions({ ...config, dbPoolMax: 2 }));
pool.on("error", () => {});

let osUser = "unknown";
try {
  osUser = userInfo().username || "unknown";
} catch {
  // Keep "unknown".
}

try {
  const store = new RoleStore(new DatabaseService(pool));
  // actorName in the store cuts `operator:<id>` to 256 characters.
  const outcome = await store.grantAdmin({ kind: "operator", id: osUser }, principal, null, { onlyIfNoActiveAdmin: true });
  if (!outcome.ok) {
    console.error(`${outcome.error.message}`);
    process.exitCode = 3;
  } else {
    console.log(`Granted: admin is now ${outcome.row.state} at revision ${outcome.row.revision} for ${principal}. One audit row was written.`);
  }
} catch (error) {
  // Safe fields only: never the stack, the URL or the config. A pg DatabaseError message comes from the server (for example
  // "password authentication failed for user ...") and holds no password.
  const name = error?.constructor?.name ?? "Error";
  const code = typeof error?.code === "string" || typeof error?.code === "number" ? ` code ${error.code}` : "";
  const detail = name === "DatabaseError" && typeof error.message === "string" ? `: ${error.message}` : "";
  console.error(`The grant failed (${name}${code})${detail}. Nothing is known to be written.`);
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
}
