import { parse as parseConnectionString } from "pg-connection-string";

/**
 * The one "is this the dev database?" guard (docs/plans/dev-licence-waiver.md section G.1), used by `loadConfig` for DEV_DEMO_WAIVER
 * and by the demo seed's `seedRefusal`. Pure; it reads only the database name, never the credentials.
 */

/** The database name in a connection string, or null when it names none (or cannot be parsed). Same parser pg uses. */
export function databaseNameOf(databaseUrl: string): string | null {
  try {
    const name = parseConnectionString(databaseUrl).database;
    return name ? name : null;
  } catch {
    return null;
  }
}

export type DevDatabaseRefusal = "no-database" | "prod" | "not-dev";

/**
 * Why this database must not be used for dev-only behaviour (null = fine). A missing name and a name ending `_prod` are always
 * refused (whatever the environment); any other name is refused unless it ends `_dev`, or `requireDev` is false.
 */
export function devDatabaseRefusal(dbName: string | null | undefined, requireDev: boolean): DevDatabaseRefusal | null {
  if (!dbName) return "no-database";
  if (dbName.endsWith("_prod")) return "prod";
  if (requireDev && !dbName.endsWith("_dev")) return "not-dev";
  return null;
}
