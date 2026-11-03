import { Body, Controller, Headers, Post, Res } from "@nestjs/common";
import type { Response } from "express";
import { Principal } from "../../auth/firebase-auth.guard.js";
import { CallerRoles, Roles } from "../../auth/roles.js";
import { ApiError } from "../../common/errors.js";
import type { AccountRole } from "../../db/enums.js";
import { SkipClientVersion } from "../../platform/client-version.js";
import { MEDIA_CONTENT_TYPES_ACCEPTED, MediaService } from "./media.service.js";

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{1,128}$/;

/** The Idempotency-Key header is required and stored with the item, so it is checked strictly. */
function idempotencyKey(value: string | undefined): string {
  if (typeof value !== "string" || !IDEMPOTENCY_KEY.test(value)) {
    throw new ApiError(400, "invalid_request", "Expected an Idempotency-Key header of 1-128 characters: letters, digits, _ and -.");
  }
  return value;
}

/** The media type of the Content-Type header, lower-cased and without parameters. */
function mediaType(header: string | undefined): string {
  return (header ?? "").split(";")[0]!.trim().toLowerCase();
}

/**
 * Staff media (docs/plans/media-pipeline.md). A photographer (an admin also qualifies) uploads; both need a verified email.
 * Exempt from the client version gate, because the website that calls it has no app build number.
 */
@Roles("photographer")
@SkipClientVersion()
@Controller("v1/admin/media")
export class MediaController {
  constructor(private readonly media: MediaService) {}

  /**
   * Upload a new image (raw bytes; the route-scoped reader in app.setup.ts reads at most 5 MB, and only for a caller whose
   * token and role are verified). 201 for a new item, 200 when the Idempotency-Key was already used with the same bytes.
   */
  @Post()
  async upload(
    @Principal() principal: string,
    @CallerRoles() roles: readonly AccountRole[],
    @Headers("idempotency-key") rawKey: string | undefined,
    @Headers("content-type") contentType: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const type = mediaType(contentType);
    if (!(MEDIA_CONTENT_TYPES_ACCEPTED as readonly string[]).includes(type)) {
      throw new ApiError(415, "invalid_request", "Send the image as the request body with Content-Type image/jpeg or image/png.");
    }
    const key = idempotencyKey(rawKey);
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw new ApiError(400, "invalid_request", "Expected the image file as the request body.");
    }
    const result = await this.media.create(principal, key, body, type, roles.includes("admin"));
    res.status(result.replayed ? 200 : 201);
    return result.item;
  }
}
