import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { ThrottlerModule } from "@nestjs/throttler";
import { FirebaseAuthGuard } from "./auth/firebase-auth.guard.js";
import { ApiExceptionFilter } from "./common/api-exception.filter.js";
import { APP_CONFIG, ConfigModule } from "./config/config.module.js";
import type { AppConfig } from "./config/config.module.js";
import { DatabaseModule } from "./database/database.module.js";
import { HealthModule } from "./health/health.module.js";
import { PlatformModule } from "./platform/drain-state.js";
import { ClientVersionGuard } from "./platform/client-version.js";
import { RateLimitGuard, throttlerOptions } from "./platform/rate-limit.js";
import { PlayersModule } from "./players/players.module.js";
import { RoundsModule } from "./rounds/rounds.module.js";

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    PlatformModule,
    ThrottlerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => throttlerOptions(config),
    }),
    PlayersModule,
    RoundsModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
    // Guards run in this order. Version gate first: an outdated client is turned away before any token
    // work. Auth next. Rate limit last, so it can key on the verified principal.
    { provide: APP_GUARD, useClass: ClientVersionGuard },
    // Every route requires a verified token unless it is marked @Public() (health only).
    { provide: APP_GUARD, useClass: FirebaseAuthGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
  ],
})
export class AppModule {}
