import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Put, Query, Res } from "@nestjs/common";
import type { PipeTransform } from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import { Principal } from "../../auth/firebase-auth.guard.js";
import { CallerRoles, Roles } from "../../auth/roles.js";
import { ApiError } from "../../common/errors.js";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { MEDIA_PUBLISHABLE_RIGHTS } from "../../db/enums.js";
import type { AccountRole, MediaPublishableRights } from "../../db/enums.js";
import { SkipClientVersion } from "../../platform/client-version.js";
import { normaliseMediaDescription } from "./media-description.js";
import { MEDIA_CONTENT_TYPES_ACCEPTED, MediaService } from "./media.service.js";
import type { MediaEdit } from "./media.service.js";

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{1,128}$/;
const MEDIA_ID = /^med-([1-9][0-9]{0,14})$/;

/** The Idempotency-Key header is required and stored with the item, so it is checked strictly. */
function idempotencyKey(value: string | undefined): string {
  if (typeof value !== "string" || !IDEMPOTENCY_KEY.test(value)) {
    throw new ApiError(400, "invalid_request", "Expected an Idempotency-Key header of 1-128 characters: letters, digits, _ and -.");
  }
  return value;
}

/** The X-Rights-Statement header is required on both uploads (sending it is the uploader's consent): exactly `v1_own` or `v1_authorised`. */
function rightsStatement(value: string | undefined): MediaPublishableRights {
  const found = (MEDIA_PUBLISHABLE_RIGHTS as readonly string[]).find((v) => v === value);
  if (found === undefined) {
    throw new ApiError(400, "invalid_request", `Expected an X-Rights-Statement header of ${MEDIA_PUBLISHABLE_RIGHTS.join(" or ")}.`);
  }
  return found as MediaPublishableRights;
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
const listQuery = z.strictObject({
  state: z.enum(["unverified", "published", "withdrawn"]).optional(),
  cursor: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).optional(),
  pending: z.literal("true").optional(),
  limit: z
    .string()
    .regex(/^[1-9][0-9]{0,2}$/)
    .transform(Number)
    .pipe(z.number().max(100))
    .optional(),
});
type ListQuery = z.infer<typeof listQuery>;
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
// Newlines are kept (CRLF becomes LF); the other control characters are refused, never stripped.
const description = z.string().transform((s, ctx) => {
  const normalised = normaliseMediaDescription(s);
  if (normalised === null) {
    ctx.addIssue({ code: "custom", message: "invalid description" });
    return z.NEVER;
  }
  return normalised;
});
const editBody = z
  .strictObject({
    revision: revisionField,
    licence: licenceEdit.optional(),
    description: description.nullable().optional(),
    note: text(1, 500).optional(),
  })
  .refine((body) => body.licence !== undefined || body.description !== undefined);
type EditBody = z.infer<typeof editBody>;
const rightsBody = z.strictObject({ revision: revisionField, statement: z.enum(MEDIA_PUBLISHABLE_RIGHTS) });
type RightsBody = z.infer<typeof rightsBody>;

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

  /** Newest first; a photographer sees their own items, an admin all. */
  @Get()
  list(
    @Principal() principal: string,
    @CallerRoles() roles: readonly AccountRole[],
    @Query(new ZodValidationPipe(listQuery, "Expected only ?state=unverified|published|withdrawn, ?pending=true, ?cursor=<a nextCursor> and ?limit=1-100.")) query: ListQuery,
  ) {
    const pending = query.pending === "true";
    if (pending && query.state !== undefined && query.state !== "published") {
      throw new ApiError(400, "invalid_request", "?pending=true lists published items with a newer draft; combine it only with ?state=published or no state.");
    }
    return this.media.list(principal, roles.includes("admin"), query.state, query.cursor, query.limit ?? 50, pending);
  }

  /** The item, its version history and a signed preview link (404 for another photographer's item). */
  @Get(":mediaId")
  get(
    @Principal() principal: string,
    @CallerRoles() roles: readonly AccountRole[],
    @Param("mediaId", new MediaIdPipe()) mediaId: number,
    @Query(new ZodValidationPipe(emptyQuery, "Expected no query parameters.")) _query: Record<string, never>,
  ) {
    return this.media.get(principal, mediaId, roles.includes("admin"));
  }

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
    @Headers("x-rights-statement") rawStatement: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { type, key, statement, bytes } = this.imageRequest(rawKey, contentType, rawStatement, body);
    const result = await this.media.create(principal, key, bytes, type, roles.includes("admin"), statement);
    res.status(result.replayed ? 200 : 201);
    return result.item;
  }

  /**
   * A new file version of an item, fenced by `?revision=`. OWNER ONLY: a non-owner admin gets 403, a non-owner photographer 404.
   * 201 new, 200 replay of the same Idempotency-Key, item, bytes and statement.
   */
  @Post(":mediaId/versions")
  async uploadVersion(
    @Principal() principal: string,
    @CallerRoles() roles: readonly AccountRole[],
    @Param("mediaId", new MediaIdPipe()) mediaId: number,
    @Query() rawQuery: unknown,
    @Headers("idempotency-key") rawKey: string | undefined,
    @Headers("content-type") contentType: string | undefined,
    @Headers("x-rights-statement") rawStatement: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    // Validated here, not by a pipe, so a malformed `mediaId` (404) is always decided before the query.
    const parsed = versionQuery.safeParse(rawQuery);
    const revision = parsed.success ? Number(parsed.data.revision) : NaN;
    if (!(revision >= 1 && revision <= 2_147_483_647)) {
      throw new ApiError(400, "invalid_request", "Expected ?revision=<the item's revision> (1 to 2147483647) and nothing else.");
    }
    const { type, key, statement, bytes } = this.imageRequest(rawKey, contentType, rawStatement, body);
    const result = await this.media.addVersion(principal, key, mediaId, revision, bytes, type, roles.includes("admin"), statement);
    res.status(result.replayed ? 200 : 201);
    return result.item;
  }

  /** Edit the draft version's licence and/or description (see MediaService.edit). */
  @Patch(":mediaId")
  async edit(
    @Principal() principal: string,
    @CallerRoles() roles: readonly AccountRole[],
    @Param("mediaId", new MediaIdPipe()) mediaId: number,
    @Query(new ZodValidationPipe(emptyQuery, "Expected no query parameters.")) _query: Record<string, never>,
    @Body(new ZodValidationPipe(editBody, "Expected { revision, licence?: { ... }, description?: string or null, note? } with at least one of licence and description, text without control characters (a description may contain newlines) and nothing else.")) body: EditBody,
  ) {
    const edit: MediaEdit = { licence: body.licence, description: body.description };
    return this.media.edit(principal, mediaId, roles.includes("admin"), body.revision, edit, body.note ?? null);
  }

  /** State the rights for a draft that has none (owner only; see MediaService.setRights). */
  @Put(":mediaId/rights")
  setRights(
    @Principal() principal: string,
    @CallerRoles() roles: readonly AccountRole[],
    @Param("mediaId", new MediaIdPipe()) mediaId: number,
    @Query(new ZodValidationPipe(emptyQuery, "Expected no query parameters.")) _query: Record<string, never>,
    @Body(new ZodValidationPipe(rightsBody, "Expected { revision: integer, statement: v1_own | v1_authorised } and nothing else.")) body: RightsBody,
  ) {
    return this.media.setRights(principal, mediaId, roles.includes("admin"), body.revision, body.statement);
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

  /** The checks both image routes share: Content-Type, Idempotency-Key, X-Rights-Statement and a non-empty raw body. All before the key lookup. */
  private imageRequest(rawKey: string | undefined, contentType: string | undefined, rawStatement: string | undefined, body: unknown) {
    const type = mediaType(contentType);
    if (!(MEDIA_CONTENT_TYPES_ACCEPTED as readonly string[]).includes(type)) {
      throw new ApiError(415, "invalid_request", "Send the image as the request body with Content-Type image/jpeg or image/png.");
    }
    const key = idempotencyKey(rawKey);
    const statement = rightsStatement(rawStatement);
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw new ApiError(400, "invalid_request", "Expected the image file as the request body.");
    }
    return { type, key, statement, bytes: body };
  }
}
