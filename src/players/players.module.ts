import { Module } from "@nestjs/common";
import { BalanceModule } from "../balance/balance.module.js";
import { PlayersController } from "./players.controller.js";
import { PlayersService } from "./players.service.js";

@Module({
  imports: [BalanceModule],
  controllers: [PlayersController],
  providers: [PlayersService],
  exports: [PlayersService],
})
export class PlayersModule {}
