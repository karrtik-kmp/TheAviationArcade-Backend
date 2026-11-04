// Import website D1 photo proposals into backend media (docs/plans/media-import.md). The command is a thin shell around the
// compiled core in dist/content/media/media-import.js, so the checks are the same code the tests run in-process.
//
// Run `npm run media:import -- --bundle <dir>` for a DRY RUN (reads the database and the bundle, prints a per-entry report, never
// writes a row, an audit entry or a blob; works with any BLOB_STORE). Add `--yes` to write: that is refused unless
// BLOB_STORE=bunny, because a memory store would be lost when the command ends. It never prints the database password.
//
// Exit codes: 0 all entries fine (imported, would import or already imported); 1 unexpected failure (database unreachable, ...)
// or entries failed with none imported; 2 refused because of the arguments, settings or manifest (nothing was contacted);
// 3 some entries refused and none imported; 4 partial success (something imported, something refused or failed).
import { userInfo } from "node:os";

try {
  process.loadEnvFile(".env");
} catch {
  // No .env file: the real environment is the only source.
}

const usage = "Usage: npm run media:import -- --bundle <dir> [--yes]";
const refuse = (message, code = 2) => {
  console.error(`${message} Nothing was written.`);
  process.exit(code);
};

const args = process.argv.slice(2);
let bundle;
let confirmed = false;
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--yes") confirmed = true;
  else if (arg === "--bundle") bundle = args[(i += 1)] ?? "";
  else if (arg.startsWith("--bundle=")) bundle = arg.slice("--bundle=".length);
  else refuse(`Unknown argument ${arg}. ${usage}.`);
}
if (bundle === undefined || bundle === "") refuse(`Give the bundle directory. ${usage}.`);

const { loadConfig } = await import("../dist/config/config.module.js");
let config;
try {
  config = loadConfig(process.env);
} catch (error) {
  refuse(error instanceof Error ? error.message : "Invalid environment configuration.");
}

const { applyRefusal, exitCodeOf, loadBundle, runMediaImport } = await import("../dist/content/media/media-import.js");
if (confirmed) {
  const why = applyRefusal(config);
  if (why !== null) refuse(why);
}

const loaded = await loadBundle(bundle);
if (!loaded.ok) refuse(loaded.error);
const manifest = loaded.manifest;

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
console.log(`Target database: host ${host}, port ${port}, database ${database} (APP_ENV=${config.appEnv}), blob store ${config.blobStore}.`);
console.log(`${confirmed ? "IMPORT" : "Dry run of"} ${manifest.entries.length} entries from ${bundle} for Firebase project ${config.firebaseProjectId}.`);

const { default: pg } = await import("pg");
const { DatabaseService, poolOptions } = await import("../dist/database/database.module.js");
const { createBlobStore } = await import("../dist/storage/storage.module.js");
const { UnavailableBlobStore } = await import("../dist/storage/unavailable-blob-store.js");

const pool = new pg.Pool(poolOptions({ ...config, dbPoolMax: 2 }));
pool.on("error", () => {});

let osUser = "unknown";
try {
  osUser = userInfo().username || "unknown";
} catch {
  // Keep "unknown".
}

try {
  // A dry run gets a store that refuses every call, so it cannot write a blob even by mistake.
  const blobs = confirmed ? createBlobStore(config) : new UnavailableBlobStore();
  const report = await runMediaImport(bundle, manifest, confirmed ? "apply" : "dry-run", {
    database: new DatabaseService(pool),
    blobs,
    config,
    operator: osUser,
  });
  const label = { imported: "imported", would_import: "would import", already_imported: "already imported", refused: "REFUSED", failed: "FAILED" };
  for (const e of report.entries) {
    const extra = [e.mediaId, e.code, e.detail].filter((part) => part !== undefined).join(" - ");
    console.log(`${e.sourceId}: ${label[e.status]}${extra ? ` (${extra})` : ""}`);
  }
  const c = report.counts;
  console.log(
    `${report.mode === "apply" ? "Applied" : "Dry run"}: ${c.imported} imported, ${c.would_import} would import, ${c.already_imported} already imported, ${c.refused} refused, ${c.failed} failed.`,
  );
  process.exitCode = exitCodeOf(report);
} catch (error) {
  // Safe fields only: never the stack, the URL or the config.
  const name = error?.constructor?.name ?? "Error";
  const code = typeof error?.code === "string" || typeof error?.code === "number" ? ` code ${error.code}` : "";
  const detail = name === "DatabaseError" && typeof error.message === "string" ? `: ${error.message}` : "";
  console.error(`The import failed (${name}${code})${detail}. Rows already committed stay; re-run to continue.`);
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
}
