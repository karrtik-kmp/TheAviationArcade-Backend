import { Global, Module } from "@nestjs/common";
import { AdminRolesController, MyRolesController } from "./accounts.controller.js";
import { RoleStore } from "./role-store.js";

/** Global so PlayersService can issue `player` at sign-in without PlayersModule importing it. Role registration, admin decisions and the role store (Backend ADR-0002). RolesGuard itself lives in src/auth/roles.ts. */
@Global()
@Module({
  controllers: [MyRolesController, AdminRolesController],
  providers: [RoleStore],
  exports: [RoleStore],
})
export class AccountsModule {}
