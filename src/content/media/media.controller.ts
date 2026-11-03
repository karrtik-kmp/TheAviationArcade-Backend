import { Body, Controller, Headers, HttpCode, Param, Patch, Post, Query, Res } from "@nestjs/common";
import type { PipeTransform } from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import { Principal } from "../../auth/firebase-auth.guard.js";
import { CallerRoles, Roles } from "../../auth/roles.js";
import { ApiError } from "../../common/errors.js";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import type { AccountRole } from "../../db/enums.js";
import { SkipClientVersion } from "../../platform/client-version.js";
import { MEDIA_CONTENT_TYPES_ACCEPTED, MediaService } from "./media.service.js";
import type { MediaLicenceEdit } from "./media.service.js";

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{1,128}$/;
const MEDIA_ID = /^med-([1-9][0-9]{0,14})$/;

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

/** `{mediaId}` route parameter: strictly `med-<n>`, anything else is 404 (the item does not exist). */
class MediaIdPipe implements PipeTransform<unknown, number> {
  transform(value: unknown): number {
    const match = typeof value === "string" ? MEDIA_ID.exec(value) : null;
    if (!match) throw new ApiError(404, "not_found", "No such media item.");
    return Number(match[1]);
  }
}

// ---- strict request shapes ----

const revisionField = z.int().min(1).max(2_147_483_647);
const revisionBody = z.strictObject({ revision: revisionField });
type RevisionBody = z.infer<typeof revisionBody>;
const emptyQuery = z.strictObject({});
const versionQuery = z.strictObject({ revision: z.string().regex(/^[1-9][0-9]{0,9}$/) });

// Text is trimmed and otherwise kept verbatim; control characters are refused. Lengths count code points, as Postgres length() does.
const CONTROL = /\p{Cc}/u;
const codePoints = (s: string) => [...s].length;
const text = (min: number, max: number) =>
  z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().refine((s) => codePoints(s) >= min && codePoints(s) <= max && !CONTROL.test(s)));
const url = z
  .string()
  .transform((s) => s.trim())
  .pipe(z.string().refine((s) => /^https?:\/\//.test(s) && codePoints(s) <= 2048 && !CONTROL.test(s)));

const licenceEdit = z
  .strictObject({
    credit: text(1, 200).nullable().optional(),
    licenceName: text(1, 200).nullable().optional(),
    licenceUrl: url.nullable().optional(),
    sourceUrl: url.nullable().optional(),
    attributionText: text(0, 1000).nullable().optional(),
    creditRequired: z.boolean().optional(),
  })
  .refine((licence) => Object.keys(licence).length > 0);
const editBody = z.strictObject({ revision: revisionField, licence: licenceEdit, note: text(1, 500).optional() });
type EditBody = z.infer<typeof editBody>;

/**
 * Staff media (docs/plans/media-pipeline.md). A photographer (an admin also qualifies) uploads and edits their own items; both
 * need a verified email. Publish and withdraw are admin-only. Exempt from the client version gate, because the website that
 * calls it has no app build number.
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
    const { type, key, bytes } = this.imageRequest(rawKey, contentType, body);
    const result = await this.media.create(principal, key, bytes, type, roles.includes("admin"));
    res.status(result.replayed ? 200 : 201);
    return result.item;
  }

  /** A new file version of an item, fenced by `?revision=`. 201 new, 200 replay of the same Idempotency-Key, item and bytes. */
  @Post(":mediaId/versions")
  async uploadVersion(
    @Principal() principal: string,
    @CallerRoles() roles: readonly AccountRole[],
    @Param("mediaId", new MediaIdPipe()) mediaId: number,
    @Query() rawQuery: unknown,
    @Headers("idempotency-key") rawKey: string | undefined,
    @Headers("content-type") contentType: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    // Validated here, not by a pipe, so a malformed `mediaId` (404) is always decided before the query.
    const parsed = versionQuery.safeParse(rawQuery);
    const revision = parsed.success ? Number(parsed.data.revision) : NaN;
    if (!(revision >= 1 && revision <= 2_147_483_647)) {
      throw new ApiError(400, "invalid_request", "Expected ?revision=<the item's revision> (1 to 2147483647) and nothing else.");
    }
    const { type, key, bytes } = this.imageRequest(rawKey, contentType, body);
    const result = await this.media.addVersion(principal, key, mediaId, revision, bytes, type, roles.includes("admin"));
    res.status(result.replayed ? 200 : 201);
    return result.item;
  }

  /** Edit the draft version's licence (see MediaService.editLicence). */
  @Patch(":mediaId")
  async edit(
    @Principal() principal: string,
    @CallerRoles() roles: readonly AccountRole[],
    @Param("mediaId", new MediaIdPipe()) mediaId: number,
    @Query(new ZodValidationPipe(emptyQuery, "Expected no query parameters.")) _query: Record<string, never>,
    @Body(new ZodValidationPipe(editBody, "Expected { revision, licence: { ... }, note? } with at least one licence field, text without control characters and nothing else.")) body: EditBody,
  ) {
    const licence: MediaLicenceEdit = body.licence;
    return this.media.editLicence(principal, mediaId, roles.includes("admin"), body.revision, licence, body.note ?? null);
  }

  @Roles("admin")
  @Post(":mediaId/publish")
  @HttpCode(200)
  publish(
    @Principal() principal: string,
    @Param("mediaId", new MediaIdPipe()) mediaId: number,
    @Query(new ZodValidationPipe(emptyQuery, "Expected no query parameters.")) _query: Record<string, never>,
    @Body(new ZodValidationPipe(revisionBody, "Expected { revision: integer } and nothing else.")) body: RevisionBody,
  ) {
    return this.media.publish(principal, mediaId, body.revision);
  }

  @Roles("admin")
  @Post(":mediaId/withdraw")
  @HttpCode(200)
  withdraw(
    @Principal() principal: string,
    @Param("mediaId", new MediaIdPipe()) mediaId: number,
    @Query(new ZodValidationPipe(emptyQuery, "Expected no query parameters.")) _query: Record<string, never>,
    @Body(new ZodValidationPipe(revisionBody, "Expected { revision: integer } and nothing else.")) body: RevisionBody,
  ) {
    return this.media.withdraw(principal, mediaId, body.revision);
  }

  /** The checks both image routes share: Content-Type, Idempotency-Key and a non-empty raw body. */
  private imageRequest(rawKey: string | undefined, contentType: string | undefined, body: unknown) {
    const type = mediaType(contentType);
    if (!(MEDIA_CONTENT_TYPES_ACCEPTED as readonly string[]).includes(type)) {
      throw new ApiError(415, "invalid_request", "Send the image as the request body with Content-Type image/jpeg or image/png.");
    }
    const key = idempotencyKey(rawKey);
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw new ApiError(400, "invalid_request", "Expected the image file as the request body.");
    }
    return { type, key, bytes: body };
  }
}
