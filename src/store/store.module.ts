import { Inject, Logger, Module } from "@nestjs/common";
import type { OnApplicationBootstrap } from "@nestjs/common";
import { APP_CONFIG } from "../config/config.module.js";
import type { AppConfig } from "../config/config.module.js";
import { DatabaseService } from "../database/database.module.js";
import { countActiveDemoProducts } from "./seed-demo.js";
import { StoreAdminController } from "./store-admin.controller.js";
import { StoreCatalogService } from "./store-catalog.service.js";
import { StoreController } from "./store.controller.js";

/**
 * The store catalog: player listing and staff editing (slice P-B of docs/plans/purchases.md). The shared reads live in
 * catalog.ts and the seed list in demo-products.ts.
 */
@Module({
  controllers: [StoreController, StoreAdminController],
  providers: [StoreCatalogService],
})
export class StoreModule implements OnApplicationBootstrap {
  private readonly log = new Logger("Store");

  constructor(
    private readonly database: DatabaseService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Demo products are hidden and unsellable in production, but an active one there means the seed ran against it: say so. Never fails startup. */
  async onApplicationBootstrap(): Promise<void> {
    if (this.config.appEnv !== "production") return;
    try {
      const n = await countActiveDemoProducts(this.database.db);
      if (n > 0) this.log.warn(`${n} active demo store product(s) exist in production; they are hidden and unsellable. Retire or remove them.`);
    } catch (error) {
      this.log.error(`Could not check for demo store products: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }
}
