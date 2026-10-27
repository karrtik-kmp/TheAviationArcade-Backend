import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { PlayersController } from "./players.controller.js";
import { PlayersService } from "./players.service.js";

@Module({
  imports: [AuthModule],
  controllers: [PlayersController],
  providers: [PlayersService],
  exports: [PlayersService],
})
export class PlayersModule {}
