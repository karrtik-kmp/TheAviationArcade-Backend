import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { ThrottlerModule } from "@nestjs/throttler";
import { AccountsModule } from "./accounts/accounts.module.js";
import { AdminModule } from "./admin/admin.module.js";
import { FirebaseAuthGuard } from "./auth/firebase-auth.guard.js";
import { RolesGuard, RolesService } from "./auth/roles.js";
import { ApiExceptionFilter } from "./common/api-exception.filter.js";
import { APP_CONFIG, ConfigModule } from "./config/config.module.js";
import type { AppConfig } from "./config/config.module.js";
import { ContentModule } from "./content/content.module.js";
import { MediaModule } from "./content/media/media.module.js";
import { DatabaseModule } from "./database/database.module.js";
import { HealthModule } from "./health/health.module.js";
import { PlatformModule } from "./platform/drain-state.js";
import { ClientVersionGuard } from "./platform/client-version.js";
import { createPostgresThrottlerStorage } from "./platform/pg-throttler-storage.js";
import { RateLimitGuard, throttlerOptions } from "./platform/rate-limit.js";
import { LogbookModule } from "./logbook/logbook.module.js";
import { PlayersModule } from "./players/players.module.js";
import { RoundsModule } from "./rounds/rounds.module.js";
import { ShopModule } from "./shop/shop.module.js";
import { StorageModule } from "./storage/storage.module.js";
import { TripsModule } from "./trips/trips.module.js";
import { UgsModule } from "./ugs/ugs.module.js";

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    StorageModule,
    PlatformModule,
    ThrottlerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        throttlerOptions(config, config.rateLimitStore === "postgres" ? createPostgresThrottlerStorage(config) : undefined),
    }),
    AccountsModule,
    PlayersModule,
    LogbookModule,
    RoundsModule,
    TripsModule,
    ShopModule,
    AdminModule,
    ContentModule,
    MediaModule,
    UgsModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
    // Guards run in this order. Version gate first: an outdated client is turned away before any token
    // work. Auth next. Rate limit next, so it can key on the verified principal. Role check last: it needs
    // the verified identity, and a caller without the role still counts against the rate limit.
    { provide: APP_GUARD, useClass: ClientVersionGuard },
    // Every route requires a verified token unless it is marked @Public() (health only).
    { provide: APP_GUARD, useClass: FirebaseAuthGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
    // Enforces @Roles() routes (Backend ADR-0002) from account_roles; a no-op everywhere else.
    RolesService,
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
