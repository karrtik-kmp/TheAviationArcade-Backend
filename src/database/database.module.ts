import { Global, Inject, Logger, Module } from "@nestjs/common";
import type { OnApplicationShutdown } from "@nestjs/common";
import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { APP_CONFIG } from "../config/config.module.js";
import type { AppConfig } from "../config/config.module.js";
import * as schema from "../db/schema.js";

export const PG_POOL = Symbol("PG_POOL");
export const DATABASE = Symbol("DATABASE");

export type Database = NodePgDatabase<typeof schema>;
/** What db.transaction() hands its callback. */
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => {
        const pool = new pg.Pool({ connectionString: config.databaseUrl });
        // An idle client dying (DB restart) must not crash the process; the pool replaces it.
        pool.on("error", (error) => new Logger("Database").error(`idle client error: ${error.message}`));
        return pool;
      },
    },
    {
      provide: DATABASE,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool): Database => drizzle({ client: pool, schema }),
    },
  ],
  exports: [DATABASE],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  /** Runs on app.close() and, via enableShutdownHooks(), on SIGTERM/SIGINT. */
  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
