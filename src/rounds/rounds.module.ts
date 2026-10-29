import { Module } from "@nestjs/common";
import { BalanceModule } from "../balance/balance.module.js";
import { RoundsController } from "./rounds.controller.js";
import { RoundsService } from "./rounds.service.js";

@Module({
  imports: [BalanceModule],
  controllers: [RoundsController],
  providers: [RoundsService],
})
export class RoundsModule {}
