import { Controller, Get } from "@nestjs/common";
import { Principal } from "../auth/firebase-auth.guard.js";
import { CallerRoles, Roles } from "../auth/roles.js";
import type { AccountRole } from "../db/enums.js";
import { SkipClientVersion } from "../platform/client-version.js";

@Roles("admin")
@SkipClientVersion()
@Controller("v1/admin")
export class AdminController {
  /**
   * Lets the website check access: 200 for an active admin (verified email), 403 `forbidden` otherwise. `staff: true` is kept
   * for existing callers; `roles` lists every ACTIVE role of the caller (Backend ADR-0002).
   */
  @Get("me")
  me(@Principal() principal: string, @CallerRoles() roles: readonly AccountRole[]) {
    return { principal, staff: true, roles: [...roles] };
  }
}
