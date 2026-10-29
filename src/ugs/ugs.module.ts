import { Module } from "@nestjs/common";
import { BalanceModule } from "../balance/balance.module.js";
import { APP_CONFIG } from "../config/config.module.js";
import type { AppConfig } from "../config/config.module.js";
import { MirrorWorker } from "./mirror-worker.js";
import { UgsClient } from "./ugs-client.js";
import type { UgsFetch } from "./ugs-client.js";
import { UgsLinkService } from "./ugs-link.service.js";
import { remoteUgsKeys } from "./ugs-token.js";
import { UgsController } from "./ugs.controller.js";
import { PROOF_CALLS_PER_MIN, TokenBucket } from "./mirror-policy.js";
import { DEFAULT_WORKER_OPTIONS, UGS_CLIENT, UGS_FETCH, UGS_KEYS, UGS_PROOF_BUCKET, UGS_WORKER_OPTIONS } from "./ugs.tokens.js";

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
    // Player Auth admin allows 500 calls / 30 min per project and IP: 12/min sustained is 360, burst of 10.
    { provide: UGS_PROOF_BUCKET, useFactory: () => new TokenBucket(PROOF_CALLS_PER_MIN, Date.now()) },
    UgsLinkService,
    MirrorWorker,
  ],
})
export class UgsModule {}
