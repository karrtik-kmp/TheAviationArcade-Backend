import { Global, Inject, Injectable, Logger, Module } from "@nestjs/common";
import type { OnApplicationShutdown } from "@nestjs/common";
import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { APP_CONFIG } from "../config/config.module.js";
import type { AppConfig } from "../config/config.module.js";
import * as schema from "../db/schema.js";

export const PG_POOL = Symbol("PG_POOL");

export type Database = NodePgDatabase<typeof schema>;
/** What a transaction callback receives. */
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Bounded waits everywhere, so a stuck lock or a dead connection becomes a quick 503 instead of a
 * request that hangs while holding a pool slot. The server-side timeouts are sent as startup options.
 */
export function poolOptions(config: Pick<AppConfig, "databaseUrl" | "dbPoolMax">): pg.PoolConfig {
  return {
    connectionString: config.databaseUrl,
    max: config.dbPoolMax,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30_000,
    keepAlive: true,
    application_name: "airplane-games-backend",
    statement_timeout: 5000,
    lock_timeout: 5000,
    idle_in_transaction_session_timeout: 15_000,
    query_timeout: 10_000,
  };
}

/** The application's database access: plain reads via `db`, balance-changing writes via withTransaction. */
@Injectable()
export class DatabaseService {
  readonly db: Database;

  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {
    this.db = drizzle({ client: pool, schema });
  }

  /**
   * Run `fn` in one transaction on a client checked out here, not by drizzle. Drizzle runs BEGIN outside
   * its own try/finally, so a failed BEGIN on a pool-owned checkout would leak the client. Here the
   * client is always released, and on failure it is released WITH the error, which makes pg destroy it
   * rather than return a possibly broken connection to the pool.
   */
  async withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let failure: Error | undefined;
    try {
      return await drizzle({ client, schema }).transaction(fn);
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
      throw error;
    } finally {
      client.release(failure);
    }
  }
}

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => {
        const pool = new pg.Pool(poolOptions(config));
        // An idle client dying (DB restart) must not crash the process; the pool replaces it.
        pool.on("error", (error) => new Logger("Database").error(`idle client error: ${error.message}`));
        return pool;
      },
    },
    DatabaseService,
  ],
  exports: [DatabaseService],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  /** Runs on app.close() and, via enableShutdownHooks(), on SIGTERM/SIGINT. */
  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
