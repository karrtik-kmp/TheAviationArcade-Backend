import { Module } from "@nestjs/common";
import { BalanceModule } from "../balance/balance.module.js";
import { CallsignService } from "./callsign.service.js";
import { CallsignsController } from "./callsigns.controller.js";
import { GuestCreationLimit } from "./guest-limit.js";
import { PlayersController } from "./players.controller.js";
import { PlayersService } from "./players.service.js";

@Module({
  imports: [BalanceModule],
  controllers: [PlayersController, CallsignsController],
  providers: [PlayersService, CallsignService, GuestCreationLimit],
  exports: [PlayersService],
})
export class PlayersModule {}
