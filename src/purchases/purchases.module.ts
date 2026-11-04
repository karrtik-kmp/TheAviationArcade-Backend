import { Module } from "@nestjs/common";
import { BalanceModule } from "../balance/balance.module.js";
import { APP_CONFIG } from "../config/config.module.js";
import type { AppConfig } from "../config/config.module.js";
import { EntitlementsService } from "./entitlements.service.js";
import { FakeStoreVerifier } from "./fake-store-verifier.js";
import { NoneStoreVerifier } from "./none-store-verifier.js";
import { PurchasesController } from "./purchases.controller.js";
import { PurchasesService } from "./purchases.service.js";
import { STORE_VERIFIER } from "./store-verifier.js";
import type { StoreVerifier } from "./store-verifier.js";

/**
 * Purchases and entitlements: `POST /v1/purchases`, `GET /v1/me/entitlements`, the store verifier port and its fake (slice P-C of
 * docs/plans/purchases.md). The verifier follows `STORE_VERIFIER` (`none` answers 503; `fake` is refused by config outside tests
 * and demo projects).
 */
@Module({
  imports: [BalanceModule],
  controllers: [PurchasesController],
  providers: [
    PurchasesService,
    EntitlementsService,
    {
      provide: STORE_VERIFIER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): StoreVerifier => (config.storeVerifier === "fake" ? new FakeStoreVerifier() : new NoneStoreVerifier()),
    },
  ],
})
export class PurchasesModule {}
