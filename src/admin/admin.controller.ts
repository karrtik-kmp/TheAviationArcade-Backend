import { Controller, Get, Query } from "@nestjs/common";
import { z } from "zod";
import { Principal } from "../auth/firebase-auth.guard.js";
import { CallerRoles, Roles } from "../auth/roles.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import type { AccountRole } from "../db/enums.js";
import { SkipClientVersion } from "../platform/client-version.js";
import { AuditReadService } from "./audit-read.js";

const emptyQuery = z.strictObject({});

@Roles("admin")
@SkipClientVersion()
@Controller("v1/admin")
export class AdminController {
  constructor(private readonly audit: AuditReadService) {}

  /**
   * Lets the website check access: 200 for an active admin (verified email), 403 `forbidden` otherwise. `staff: true` is kept
   * for existing callers; `roles` lists every ACTIVE role of the caller (Backend ADR-0002).
   */
  @Get("me")
  me(@Principal() principal: string, @CallerRoles() roles: readonly AccountRole[]) {
    return { principal, staff: true, roles: [...roles] };
  }

  /** The audit desk (docs/plans/website-content.md W4): the newest 50 `admin_audit` rows, admin only, no query parameters. */
  @Get("audit")
  async auditEvents(@Query(new ZodValidationPipe(emptyQuery, "Expected no query parameters.")) _query: Record<string, never>) {
    return this.audit.latest();
  }
}
