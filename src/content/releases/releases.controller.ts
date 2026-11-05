import { Body, Controller, Get, HttpCode, Param, Post } from "@nestjs/common";
import { Principal } from "../../auth/firebase-auth.guard.js";
import { Roles } from "../../auth/roles.js";
import { ApiError } from "../../common/errors.js";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { SkipClientVersion } from "../../platform/client-version.js";
import { RELEASE_MODULE, pointerBody, uploadBody } from "./release-rules.js";
import type { PointerBody, UploadBody } from "./release-rules.js";
import { ReleaseStore } from "./release-store.js";

/** Only the Military module has releases; any other module (or an unknown name) is a 404, like an unknown route. */
function militaryOnly(module: string): void {
  if (module !== RELEASE_MODULE) throw new ApiError(404, "not_found", "No such endpoint.");
}

/** A release number is a positive integer; anything else cannot exist (404). */
function releaseNumber(raw: string): number {
  if (!/^[1-9][0-9]{0,8}$/.test(raw)) throw new ApiError(404, "not_found", "No such release.");
  return Number(raw);
}

/**
 * Military releases (docs/plans/website-content.md W3 commit 2). Admin only, exempt from the client version gate like the rest of
 * `/v1/admin/content`. RECORDED, NOT DELIVERED: these routes record what staff released; no player route reads it yet.
 */
@Roles("admin")
@SkipClientVersion()
@Controller("v1/admin/content")
export class ReleasesController {
  constructor(private readonly releases: ReleaseStore) {}

  @Get(":module/releases")
  async list(@Param("module") module: string) {
    militaryOnly(module);
    return this.releases.list();
  }

  @Post(":module/releases")
  async upload(
    @Principal() principal: string,
    @Param("module") module: string,
    @Body(new ZodValidationPipe(uploadBody, "Expected { itemIds: 1 to 2000 item ids, basis: string, previewed: boolean, note?: string } and nothing else.")) body: UploadBody,
  ) {
    militaryOnly(module);
    return this.releases.upload(body, principal);
  }

  // `restore` is a different path shape from `:version/activate`, so the two never compete for a request.
  @Post(":module/releases/restore")
  @HttpCode(200)
  async restore(
    @Principal() principal: string,
    @Param("module") module: string,
    @Body(new ZodValidationPipe(pointerBody, "Expected { expectedPointerVersion: integer, note?: string } and nothing else.")) body: PointerBody,
  ) {
    militaryOnly(module);
    return this.releases.restore(body.expectedPointerVersion, body.note, principal);
  }

  @Post(":module/releases/:version/activate")
  @HttpCode(200)
  async activate(
    @Principal() principal: string,
    @Param("module") module: string,
    @Param("version") version: string,
    @Body(new ZodValidationPipe(pointerBody, "Expected { expectedPointerVersion: integer, note?: string } and nothing else.")) body: PointerBody,
  ) {
    militaryOnly(module);
    return this.releases.activate(releaseNumber(version), body.expectedPointerVersion, body.note, principal);
  }
}
