// The dev Code Search seed (docs/plans/code-search.md section 4): load the client's master pack (Unity's code_search_master.json,
// schemaVersion 2) into a DEV backend through the Admin's content import path. A thin shell around the compiled core in
// dist/content/code-search-seed.js, so the checks are the same code the tests run in-process.
//
// Run `npm run demo:seed-code-search -- --pack <code_search_master.json>` for a DRY RUN (reads the database and the pack, prints one line
// per rank and the totals; writes nothing, not even a blob; works with any BLOB_STORE). Add `--yes` to write: needs a blob store that
// outlives the command (BLOB_STORE=bunny under APP_ENV=production, never none). The seed only creates boards: any update or retirement
// of stored boards is refused (exit 3); change stored boards in the Admin import.
//
// It never prints the database password or a key. Exit codes: 0 nothing wrong; 1 unexpected failure, or a step failed with nothing done;
// 2 refused because of the arguments, settings, pack or target database (nothing was contacted); 3 something refused and nothing done.
import { userInfo } from "node:os";

try {
  process.loadEnvFile(".env");
} catch {
  // No .env file: the real environment is the only source.
}

const usage = "Usage: npm run demo:seed-code-search -- --pack <code_search_master.json> [--yes]";
const refuse = (message, code = 2) => {
  console.error(`${message} Nothing was written.`);
  process.exit(code);
};

const args = process.argv.slice(2);
let pack;
let confirmed = false;
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--yes") confirmed = true;
  else if (arg === "--pack" || arg.startsWith("--pack=")) {
    if (arg.startsWith("--pack=")) pack = arg.slice("--pack=".length);
    else {
      pack = args[i + 1] ?? "";
      i += 1;
    }
  } else refuse(`Unknown argument ${arg}. ${usage}.`);
}
if (pack === undefined || pack === "") refuse(`Give --pack. ${usage}.`);

const { loadConfig } = await import("../dist/config/config.module.js");
let config;
try {
  config = loadConfig(process.env);
} catch (error) {
  refuse(error instanceof Error ? error.message : "Invalid environment configuration.");
}

let host;
let port;
let database;
try {
  const { default: parseConnectionString } = await import("pg-connection-string");
  const parsed = parseConnectionString.parse(config.databaseUrl);
  host = parsed.host ?? "(default socket)";
  port = parsed.port ?? "(default)";
  database = parsed.database ?? undefined;
} catch {
  refuse("DATABASE_URL could not be parsed.");
}

const { codeSearchSeedRefusal, loadCodeSearchPack, runCodeSearchSeed, exitCodeOf, MAX_LISTED } = await import("../dist/content/code-search-seed.js");
const why = codeSearchSeedRefusal(config, database, { yes: confirmed });
if (why !== null) refuse(why);

const loaded = await loadCodeSearchPack(pack);
if (!loaded.ok) {
  const shown = loaded.errors.slice(0, MAX_LISTED).map((e) => `  - ${e}`);
  refuse(`The pack ${pack} is not usable (${loaded.errors.length} problem(s)):\n${shown.join("\n")}${loaded.errors.length > MAX_LISTED ? `\n  ... ${loaded.errors.length - MAX_LISTED} more` : ""}\n`);
}

console.log(
  `Target database: host ${host}, port ${port}, database ${database} (APP_ENV=${config.appEnv}), Firebase project ${config.firebaseProjectId}, blob store ${config.blobStore}.`,
);
console.log(
  `${confirmed ? "SEED" : "Dry run of the seed"} from ${pack}: packId ${loaded.pack.packId}, contentVersion ${loaded.pack.contentVersion}, sourceSha256 ${loaded.pack.sourceSha256}, ${loaded.pack.records.length} records.`,
);

const { default: pg } = await import("pg");
const { DatabaseService, poolOptions } = await import("../dist/database/database.module.js");
const { createBlobStore } = await import("../dist/storage/storage.module.js");
const { UnavailableBlobStore } = await import("../dist/storage/unavailable-blob-store.js");

// Two connections at least: one holds the run lock, the others do the work.
const pool = new pg.Pool(poolOptions({ ...config, dbPoolMax: 4 }));
pool.on("error", () => {});

let osUser = "unknown";
try {
  osUser = userInfo().username || "unknown";
} catch {
  // Keep "unknown".
}

try {
  const db = new DatabaseService(pool);
  // A dry run gets a store that refuses every call, so it cannot write a blob even by mistake.
  const blobs = confirmed ? createBlobStore(config) : new UnavailableBlobStore();
  const report = await runCodeSearchSeed(loaded.pack, confirmed ? "apply" : "dry-run", { database: db, blobs, operator: osUser, pool });
  const label = { done: "done", would: "would", unchanged: "unchanged", waiting: "WAITING", note: "note", refused: "REFUSED", failed: "FAILED" };
  for (const line of report.lines) {
    const extra = [line.detail].filter((part) => part !== undefined && part !== "").join(" - ");
    console.log(`${line.section} ${line.subject}: ${label[line.status]}${extra ? ` (${extra})` : ""}`);
  }
  const c = report.counts;
  console.log(`${report.mode === "apply" ? "Applied" : "Dry run"}: ${c.done} done, ${c.would} would, ${c.unchanged} unchanged, ${c.note} notes, ${c.refused} refused, ${c.failed} failed.`);
  process.exitCode = exitCodeOf(report);
} catch (error) {
  // Safe fields only: never the stack, the URL or the config.
  const name = error?.constructor?.name ?? "Error";
  const code = typeof error?.code === "string" || typeof error?.code === "number" ? ` code ${error.code}` : "";
  const detail = name === "DatabaseError" && typeof error.message === "string" ? `: ${error.message}` : "";
  console.error(`The seed failed (${name}${code})${detail}. Rows already committed stay; re-run to continue.`);
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
}
