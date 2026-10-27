import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { FirebaseAuthGuard } from "./auth/firebase-auth.guard.js";
import { ApiExceptionFilter } from "./common/api-exception.filter.js";
import { ConfigModule } from "./config/config.module.js";
import { DatabaseModule } from "./database/database.module.js";
import { HealthModule } from "./health/health.module.js";
import { PlayersModule } from "./players/players.module.js";
import { RoundsModule } from "./rounds/rounds.module.js";

@Module({
  imports: [ConfigModule, DatabaseModule, PlayersModule, RoundsModule, HealthModule],
  providers: [
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
    // Every route requires a verified token unless it is marked @Public() (health only).
    { provide: APP_GUARD, useClass: FirebaseAuthGuard },
  ],
})
export class AppModule {}
