import { Module } from "@nestjs/common";
import { PlayerBalance } from "./player-balance.js";

@Module({
  providers: [PlayerBalance],
  exports: [PlayerBalance],
})
export class BalanceModule {}
