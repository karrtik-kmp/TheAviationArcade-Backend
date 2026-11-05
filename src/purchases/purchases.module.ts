import { Logger, Module } from "@nestjs/common";
import { BalanceModule } from "../balance/balance.module.js";
import { APP_CONFIG } from "../config/config.module.js";
import type { AppConfig } from "../config/config.module.js";
import { EntitlementsService } from "./entitlements.service.js";
import { AppleStoreVerifier } from "./apple-store-verifier.js";
import { GoogleStoreVerifier } from "./google-store-verifier.js";
import { FakeStoreVerifier } from "./fake-store-verifier.js";
import { NoneStoreVerifier } from "./none-store-verifier.js";
import { PurchasesController } from "./purchases.controller.js";
import { PurchasesService } from "./purchases.service.js";
import { STORE_VERIFIER } from "./store-verifier.js";
import { StoresVerifier } from "./stores-verifier.js";
import type { StoreVerifier } from "./store-verifier.js";

/**
 * The `stores` verifier: one composite over the adapters of the configured stores. The Apple (P2) and Google (P3) adapters plug
 * in here, each built from `config.apple` / `config.google`; a store without an adapter answers transient. The start-up line
 * names the stores, the Apple Key ID and the Google service-account email, never paths or key material.
 */
export function createStoresVerifier(config: AppConfig): StoreVerifier {
  new Logger("Purchases").log(
    `store verifier: stores (apple: ${config.apple ? `key ${config.apple.keyId}` : "off"}, google: ${config.google ? config.google.clientEmail : "off"})`,
  );
  return new StoresVerifier(
    config.apple ? new AppleStoreVerifier(config.apple) : undefined,
    config.google ? new GoogleStoreVerifier(config.google) : undefined,
  );
}

/**
 * Purchases and entitlements: `POST /v1/purchases`, `GET /v1/me/entitlements`, the store verifier port and its fake (slice P-C of
 * docs/plans/purchases.md). The verifier follows `STORE_VERIFIER` (`none` answers 503; `fake` is refused by config outside tests
 * and demo projects; `stores` dispatches to Apple and Google).
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
      useFactory: (config: AppConfig): StoreVerifier => {
        if (config.storeVerifier === "fake") return new FakeStoreVerifier();
        if (config.storeVerifier === "stores") return createStoresVerifier(config);
        return new NoneStoreVerifier();
      },
    },
  ],
})
export class PurchasesModule {}
