// The dev demo seed (scenario E4, docs/plans/demo-seed.md): load the client's Military and Aircraft Identifier questions, their
// photos and the five Plane of the Day entries into a DEV backend, through the same write paths the Admin uses. A thin shell around
// the compiled core in dist/content/demo-seed.js, so the checks are the same code the tests run in-process.
//
// Run `npm run demo:seed-content -- --docs <dir> --delivery <dir> --owner <uid> [--photographer <uid>]... [--photographers <file>]`
// for a DRY RUN (reads the database and the files, prints one line per role, question set, photo, link and entry; writes nothing,
// not even a blob; works with any BLOB_STORE). Add `--yes` to write: refused unless BLOB_STORE=bunny and DEMO_ACCOUNT_UID is set.
// WITH --yes THE OPERATOR STATES THAT THE CLIENT'S PHOTOS ARE v1_authorised (the client's licence). Nothing is ever published.
//
//   --docs <dir>        the docs folder holding "Military Airplane Identifier v1.xlsx" and its "- Pictures" folder
//   --delivery <dir>    the client delivery folder (2026-09-28) with the Identifier and Plane of the Day sheets and folders
//   --owner <uid>       the staff photographer (or admin) account that owns every photo; a bare Firebase uid of the configured project
//   --photographer <uid>  a real photographer to grant the photographer role (repeatable)
//   --photographers <file>  the same, one uid per line, # starts a comment
//
// It never prints the database password or a key. Exit codes: 0 nothing wrong; 1 unexpected failure, or a step failed with nothing
// done; 2 refused because of the arguments, settings, files or target database (nothing was contacted); 3 something refused and
// nothing done; 4 partial (something done, something refused or failed).
import { userInfo } from "node:os";

try {
  process.loadEnvFile(".env");
} catch {
  // No .env file: the real environment is the only source.
}

const usage =
  "Usage: npm run demo:seed-content -- --docs <dir> --delivery <dir> --owner <uid> [--photographer <uid>]... [--photographers <file>] [--yes]";
const refuse = (message, code = 2) => {
  console.error(`${message} Nothing was written.`);
  process.exit(code);
};

const args = process.argv.slice(2);
let docs;
let delivery;
let owner;
let photographersFile;
const photographerArgs = [];
let confirmed = false;
const valueOf = (i, name) => {
  const arg = args[i];
  return arg.startsWith(`${name}=`) ? [arg.slice(name.length + 1), i] : [args[i + 1] ?? "", i + 1];
};
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--yes") confirmed = true;
  else if (arg === "--docs" || arg.startsWith("--docs=")) [docs, i] = valueOf(i, "--docs");
  else if (arg === "--delivery" || arg.startsWith("--delivery=")) [delivery, i] = valueOf(i, "--delivery");
  else if (arg === "--owner" || arg.startsWith("--owner=")) [owner, i] = valueOf(i, "--owner");
  else if (arg === "--photographers" || arg.startsWith("--photographers=")) [photographersFile, i] = valueOf(i, "--photographers");
  else if (arg === "--photographer" || arg.startsWith("--photographer=")) {
    const [value, next] = valueOf(i, "--photographer");
    photographerArgs.push(value);
    i = next;
  } else refuse(`Unknown argument ${arg}. ${usage}.`);
}
for (const [name, value] of [["--docs", docs], ["--delivery", delivery], ["--owner", owner]]) {
  if (value === undefined || value === "") refuse(`Give ${name}. ${usage}.`);
}

const { loadConfig } = await import("../dist/config/config.module.js");
let config;
try {
  config = loadConfig(process.env);
} catch (error) {
  refuse(error instanceof Error ? error.message : "Invalid environment configuration.");
}

const { readRegularFile } = await import("../dist/content/media/media-import.js");
const photographers = [...photographerArgs];
if (photographersFile !== undefined) {
  const read = await readRegularFile(photographersFile, 64 * 1024);
  if (!read.ok) refuse(`--photographers file: ${read.detail}`);
  for (const raw of Buffer.from(read.bytes).toString("utf8").split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line !== "") photographers.push(line);
  }
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

const { seedRefusal, resolveSeedPrincipal, loadSeedInputs, runDemoSeed, exitCodeOf, unseenPrincipals } = await import("../dist/content/demo-seed.js");
const why = seedRefusal(config, database, { owner, photographers, yes: confirmed });
if (why !== null) refuse(why);

const loaded = await loadSeedInputs(docs, delivery);
if (!loaded.ok) refuse(loaded.error);

const ownerPrincipal = resolveSeedPrincipal(config, owner).principal;
const photographerPrincipals = [...new Set(photographers.map((p) => resolveSeedPrincipal(config, p).principal))];

console.log(
  `Target database: host ${host}, port ${port}, database ${database} (APP_ENV=${config.appEnv}), Firebase project ${config.firebaseProjectId}, blob store ${config.blobStore}.`,
);
console.log(`${confirmed ? "SEED" : "Dry run of the seed"} from ${docs} and ${delivery}.`);
console.log(`Owner of every photo: ${ownerPrincipal}`);
console.log(`Photographers to grant (${photographerPrincipals.length}): ${photographerPrincipals.length === 0 ? "none" : photographerPrincipals.join(", ")}`);
if (confirmed) {
  console.log("With --yes you state that the client's photos are v1_authorised (the client's licence). Nothing is published.");
}

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
  for (const principal of await unseenPrincipals(db.db, [...new Set([ownerPrincipal, ...photographerPrincipals])])) {
    console.log(`WARNING: the backend has never seen ${principal} (no player and no role row). Check the uid; the seed cannot prove it exists in Firebase.`);
  }
  // A dry run gets a store that refuses every call, so it cannot write a blob even by mistake.
  const blobs = confirmed ? createBlobStore(config) : new UnavailableBlobStore();
  const report = await runDemoSeed(loaded.inputs, ownerPrincipal, photographerPrincipals, confirmed ? "apply" : "dry-run", {
    database: db,
    blobs,
    config,
    operator: osUser,
    pool,
  });
  const label = { done: "done", would: "would", unchanged: "unchanged", waiting: "WAITING", note: "note", refused: "REFUSED", failed: "FAILED" };
  for (const line of report.lines) {
    const extra = [line.mediaId, line.detail].filter((part) => part !== undefined && part !== "").join(" - ");
    console.log(`${line.section} ${line.subject}: ${label[line.status]}${extra ? ` (${extra})` : ""}`);
  }
  const c = report.counts;
  console.log(
    `${report.mode === "apply" ? "Applied" : "Dry run"}: ${c.done} done, ${c.would} would, ${c.unchanged} unchanged, ${c.waiting} waiting, ${c.note} notes, ${c.refused} refused, ${c.failed} failed.`,
  );
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
