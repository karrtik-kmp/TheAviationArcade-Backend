import { Module } from "@nestjs/common";
import { ShopController } from "./shop.controller.js";
import { ShopService } from "./shop.service.js";

@Module({
  controllers: [ShopController],
  providers: [ShopService],
})
export class ShopModule {}
