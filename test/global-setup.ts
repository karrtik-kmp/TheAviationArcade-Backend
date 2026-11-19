import type { ChildProcess } from "node:child_process";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

/** True only when the Firebase Auth Emulator answers at `host` (its root is JSON `{ authEmulator: { ready: true } }`). */
async function reachable(host: string): Promise<boolean> {
  try {
    const response = await fetch(`http://${host}/`, { signal: AbortSignal.timeout(1_000) });
    const body = (await response.json()) as { authEmulator?: { ready?: boolean } };
    return body.authEmulator?.ready === true;
  } catch {
    return false;
  }
}

/**
 * The admin grant marks emails verified through the Firebase Auth Emulator (ADR-0002 follow-up 2026-11-19). Reuse one already
 * listening at FIREBASE_AUTH_EMULATOR_HOST, otherwise start the pinned firebase-tools one (scripts/auth-emulator.mjs) and stop it
 * after the run. Test uids are unique per run, so a reused emulator's leftover accounts never clash.
 */
async function ensureAuthEmulator(): Promise<(() => Promise<void>) | undefined> {
  const host = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  if (!host) throw new Error("FIREBASE_AUTH_EMULATOR_HOST is not set for the e2e run.");
  if (await reachable(host)) return undefined;
  const script = "../scripts/auth-emulator.mjs"; // a plain .mjs without types: imported by a variable path
  const { startAuthEmulator, stopAuthEmulator } = (await import(script)) as {
    startAuthEmulator: (stdio: string) => ChildProcess;
    stopAuthEmulator: (child: ChildProcess) => void;
  };
  const child = startAuthEmulator("pipe");
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => (output = (output + chunk.toString()).slice(-4000)));
  child.stderr?.on("data", (chunk: Buffer) => (output = (output + chunk.toString()).slice(-4000)));
  const deadline = Date.now() + 180_000; // the first run downloads firebase-tools
  while (!(await reachable(host))) {
    if (child.exitCode !== null || Date.now() > deadline) {
      stopAuthEmulator(child);
      throw new Error(`The Firebase Auth Emulator did not start at ${host}:\n${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return async () => {
    stopAuthEmulator(child);
  };
}

/** Runs once before the e2e suite: make sure the test database exists and is migrated, and the Auth Emulator is up. */
export default async function setup(): Promise<(() => Promise<void>) | undefined> {
  const stopEmulator = await ensureAuthEmulator();
  try {
    await setupDatabase();
  } catch (error) {
    await stopEmulator?.();
    throw error;
  }
  return stopEmulator;
}

async function setupDatabase(): Promise<void> {
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
