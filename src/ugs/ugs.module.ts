import { Module } from "@nestjs/common";
import { BalanceModule } from "../balance/balance.module.js";
import { APP_CONFIG } from "../config/config.module.js";
import type { AppConfig } from "../config/config.module.js";
import { DatabaseService } from "../database/database.module.js";
import { MirrorWorker } from "./mirror-worker.js";
import { UgsClient } from "./ugs-client.js";
import type { UgsFetch } from "./ugs-client.js";
import { UgsLinkService } from "./ugs-link.service.js";
import { remoteUgsKeys } from "./ugs-token.js";
import { UgsController } from "./ugs.controller.js";
import { CLOUD_SAVE_BUDGET, PLAYER_AUTH_BUDGET, PostgresUgsBudget } from "./budget.js";
import { PROOF_CALLS_PER_MIN } from "./mirror-policy.js";
import {
  DEFAULT_WORKER_OPTIONS,
  UGS_BUDGET,
  UGS_CLIENT,
  UGS_FETCH,
  UGS_KEYS,
  UGS_PROOF_BUDGET,
  UGS_WORKER_OPTIONS,
} from "./ugs.tokens.js";
import type { UgsWorkerOptions } from "./ugs.tokens.js";

@Module({
  imports: [BalanceModule],
  controllers: [UgsController],
  providers: [
    // The real network fetcher and key set; tests override both so nothing reaches Unity.
    { provide: UGS_FETCH, useValue: ((url, init) => fetch(url, init)) satisfies UgsFetch },
    { provide: UGS_KEYS, useValue: remoteUgsKeys },
    { provide: UGS_WORKER_OPTIONS, useValue: DEFAULT_WORKER_OPTIONS },
    {
      provide: UGS_CLIENT,
      inject: [APP_CONFIG, UGS_FETCH],
      useFactory: (config: AppConfig, fetcher: UgsFetch) => (config.ugs ? new UgsClient(config.ugs, fetcher) : null),
    },
    // Shared across instances through one ugs_budget row each (D-4). Cloud Save admin: UGS_MIRROR_MAX_PER_MIN, burst <= 10.
    {
      provide: UGS_BUDGET,
      inject: [APP_CONFIG, DatabaseService, UGS_WORKER_OPTIONS],
      useFactory: (config: AppConfig, database: DatabaseService, options: UgsWorkerOptions) =>
        config.ugs
          ? new PostgresUgsBudget(database, CLOUD_SAVE_BUDGET, config.ugs.mirrorMaxPerMin, undefined, options.budgetTime)
          : null,
    },
    // Player Auth admin allows 500 calls / 30 min per project and IP: 12/min sustained is 360, burst of 10.
    {
      provide: UGS_PROOF_BUDGET,
      inject: [DatabaseService, UGS_WORKER_OPTIONS],
      useFactory: (database: DatabaseService, options: UgsWorkerOptions) =>
        new PostgresUgsBudget(database, PLAYER_AUTH_BUDGET, PROOF_CALLS_PER_MIN, undefined, options.budgetTime),
    },
    UgsLinkService,
    MirrorWorker,
  ],
})
export class UgsModule {}
