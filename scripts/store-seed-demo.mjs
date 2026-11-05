// Seed the demo store catalog (the client's four products plus the two placeholder Miles packs, with placeholder store ids; src/store/demo-products.ts).
//
// Run `npm run store:seed-demo` (it builds first). Refused when APP_ENV=production. Idempotent: it inserts only the missing rows
// (ON CONFLICT DO NOTHING) and never edits an existing one, so staff changes survive. It never prints the database password.
//
// Exit codes: 0 done (rows inserted or already present); 1 unexpected failure (database unreachable, ...); 2 refused because of
// the settings (nothing was contacted).
try {
  process.loadEnvFile(".env");
} catch {
  // No .env file: the real environment is the only source.
}

const refuse = (message, code = 2) => {
  console.error(`${message} Nothing was written.`);
  process.exit(code);
};

const { loadConfig } = await import("../dist/config/config.module.js");
let config;
try {
  config = loadConfig(process.env);
} catch (error) {
  refuse(error instanceof Error ? error.message : "Invalid environment configuration.");
}
if (config.appEnv === "production") refuse("The demo catalog cannot be seeded when APP_ENV=production.");

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
console.log(`Target database: host ${host}, port ${port}, database ${database} (APP_ENV=${config.appEnv}).`);

const { default: pg } = await import("pg");
const { DatabaseService, poolOptions } = await import("../dist/database/database.module.js");
const { seedDemoCatalog } = await import("../dist/store/seed-demo.js");

const pool = new pg.Pool(poolOptions({ ...config, dbPoolMax: 2 }));
pool.on("error", () => {});

try {
  const inserted = await seedDemoCatalog(new DatabaseService(pool).db, config.appEnv);
  console.log(
    inserted.length === 0
      ? "The demo catalog is already seeded; nothing changed."
      : `Seeded ${inserted.length} demo product(s): ${inserted.join(", ")}.`,
  );
} catch (error) {
  const name = error?.constructor?.name ?? "Error";
  const code = typeof error?.code === "string" || typeof error?.code === "number" ? ` code ${error.code}` : "";
  const detail = name === "DatabaseError" && typeof error.message === "string" ? `: ${error.message}` : "";
  console.error(`The seed failed (${name}${code})${detail}. Nothing is known to be written.`);
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
}
