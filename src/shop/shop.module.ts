import { Module } from "@nestjs/common";
import { BalanceModule } from "../balance/balance.module.js";
import { ShopController } from "./shop.controller.js";
import { ShopService } from "./shop.service.js";

@Module({
  imports: [BalanceModule],
  controllers: [ShopController],
  providers: [ShopService],
})
export class ShopModule {}
