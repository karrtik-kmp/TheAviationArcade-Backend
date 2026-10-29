import { Controller, Get } from "@nestjs/common";
import { Principal } from "../auth/firebase-auth.guard.js";
import { StaffOnly } from "../auth/staff.js";
import { SkipClientVersion } from "../platform/client-version.js";

@StaffOnly()
@SkipClientVersion()
@Controller("v1/admin")
export class AdminController {
  /** Lets the website check whether the signed-in caller is staff: 200 for staff, 403 `forbidden` otherwise. */
  @Get("me")
  me(@Principal() principal: string) {
    return { principal, staff: true };
  }
}
