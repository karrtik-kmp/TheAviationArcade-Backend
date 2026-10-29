import { Module } from "@nestjs/common";
import { BalanceModule } from "../balance/balance.module.js";
import { TripsController } from "./trips.controller.js";
import { TripsService } from "./trips.service.js";

@Module({
  imports: [BalanceModule],
  controllers: [TripsController],
  providers: [TripsService],
})
export class TripsModule {}
