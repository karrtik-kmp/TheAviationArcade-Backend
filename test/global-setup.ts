import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

/** Runs once before the e2e suite: make sure the test database exists and is migrated. */
export default async function setup(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set for the e2e run.");
  const target = new URL(url);
  const dbName = decodeURIComponent(target.pathname.slice(1));
  // Refuse to migrate anything that is not obviously a test database.
  if (!dbName.endsWith("_test")) throw new Error(`Refusing to run e2e tests against "${dbName}".`);

  // Create the database if the compose init script did not (e.g. a volume that predates it).
  const admin = new pg.Client({ connectionString: new URL("/postgres", target).toString() });
  await admin.connect();
  try {
    const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
    if (exists.rowCount === 0) await admin.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
  } finally {
    await admin.end();
  }

  const pool = new pg.Pool({ connectionString: url });
  try {
    await migrate(drizzle({ client: pool }), { migrationsFolder: "./drizzle" });
  } finally {
    await pool.end();
  }
}
