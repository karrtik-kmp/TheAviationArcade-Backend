import { Controller, Get, Inject } from "@nestjs/common";
import { APP_CONFIG } from "../config/config.module.js";
import type { AppConfig } from "../config/config.module.js";
import { StoreCatalogService } from "./store-catalog.service.js";

/** Any signed-in caller: the products on offer (no title, no price). */
@Controller("v1/store")
export class StoreController {
  constructor(
    private readonly catalog: StoreCatalogService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get("products")
  async products() {
    return { products: await this.catalog.listListed(this.config.appEnv) };
  }
}
