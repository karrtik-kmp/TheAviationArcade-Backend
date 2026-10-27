import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { RoundsController } from "./rounds.controller.js";
import { RoundsService } from "./rounds.service.js";

@Module({
  imports: [AuthModule],
  controllers: [RoundsController],
  providers: [RoundsService],
})
export class RoundsModule {}
