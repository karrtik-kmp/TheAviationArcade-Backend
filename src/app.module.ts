import { Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { AuthModule } from "./auth/auth.module.js";
import { ApiExceptionFilter } from "./common/api-exception.filter.js";
import { ConfigModule } from "./config/config.module.js";
import { DatabaseModule } from "./database/database.module.js";
import { HealthModule } from "./health/health.module.js";
import { PlayersModule } from "./players/players.module.js";
import { RoundsModule } from "./rounds/rounds.module.js";

@Module({
  imports: [ConfigModule, DatabaseModule, AuthModule, PlayersModule, RoundsModule, HealthModule],
  providers: [{ provide: APP_FILTER, useClass: ApiExceptionFilter }],
})
export class AppModule {}
