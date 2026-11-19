import { Global, Module } from "@nestjs/common";
import { APP_CONFIG } from "../config/config.module.js";
import type { AppConfig } from "../config/config.module.js";
import { AdminRolesController, MyRolesController } from "./accounts.controller.js";
import { FIREBASE_ACCOUNTS, firebaseAccountsFor } from "./firebase-accounts.js";
import { RoleStore } from "./role-store.js";

/** Global so PlayersService can issue `player` at sign-in without PlayersModule importing it. Role registration, admin decisions and the role store (Backend ADR-0002). RolesGuard itself lives in src/auth/roles.ts. */
@Global()
@Module({
  controllers: [MyRolesController, AdminRolesController],
  providers: [
    RoleStore,
    // Firebase admin access for the admin grant (ADR-0002 follow-up 2026-11-19); answers not_configured when config.firebaseAdmin is unset.
    { provide: FIREBASE_ACCOUNTS, inject: [APP_CONFIG], useFactory: (config: AppConfig) => firebaseAccountsFor(config.firebaseAdmin) },
  ],
  exports: [RoleStore],
})
export class AccountsModule {}
