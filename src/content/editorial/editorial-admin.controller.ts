import { Body, Controller, Get, Param, Post, Put } from "@nestjs/common";
import { z } from "zod";
import { Principal } from "../../auth/firebase-auth.guard.js";
import { Roles } from "../../auth/roles.js";
import { ApiError } from "../../common/errors.js";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { EDITORIAL_STATUSES } from "../../db/enums.js";
import type { EditorialKind } from "../../db/enums.js";
import { SkipClientVersion } from "../../platform/client-version.js";
import { MEDIA_ID_PATTERN, parseMediaId } from "../item-media-id.js";
import { isEditorialKind, parseEditorialId } from "./editorial-rules.js";
import { EditorialService } from "./editorial.service.js";

// Structure only (strict: an unknown key such as `imageUrl` is a 400). The VALUES (lengths, distractor count, rank, handle) are
// checked by normaliseEditorialData and answer 422 with the reasons. Every key is required: a save replaces the whole state.
const textField = z.string();
const dataBody = z.strictObject({
  title: textField,
  aircraft: textField,
  photographer: textField,
  instagram: textField,
  credit: textField,
  description: textField,
  correctAnswer: textField,
  distractors: z.array(textField).max(20),
  difficulty: textField,
  factualSource: textField,
});
const createBody = z.strictObject({ mediaId: z.string().regex(MEDIA_ID_PATTERN), data: dataBody.optional() });
type CreateBody = z.infer<typeof createBody>;
const saveBody = z.strictObject({
  version: z.number().int().min(1).max(2_147_483_647),
  status: z.enum(EDITORIAL_STATUSES),
  data: dataBody,
  dateKey: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.null()]).optional(),
});
type SaveBody = z.infer<typeof saveBody>;

/** An unknown kind is a 404, like an unknown route. */
function kindOf(kind: string): EditorialKind {
  if (!isEditorialKind(kind)) throw new ApiError(404, "not_found", "No such endpoint.");
  return kind;
}

/**
 * Staff editorial desks: the Aircraft Identifier desk (`identifier`) and Plane of the Day (`plane-of-the-day`). Admin only
 * (`@Roles("admin")`, Backend ADR-0002; photographers never use these desks), exempt from the client version gate because the
 * website that calls it has no app build number. Rate limited like every authenticated route.
 */
@Roles("admin")
@SkipClientVersion()
@Controller("v1/admin/editorial")
export class EditorialAdminController {
  constructor(private readonly editorial: EditorialService) {}

  @Get(":kind/items")
  async items(@Param("kind") kind: string) {
    return { items: await this.editorial.list(kindOf(kind)) };
  }

  /** 201 `{ item }`: a draft v1 for a published photo. */
  @Post(":kind/items")
  async create(
    @Principal() principal: string,
    @Param("kind") kind: string,
    @Body(new ZodValidationPipe(createBody, 'Expected { mediaId: "med-<n>", data?: the ten editorial fields } and nothing else.')) body: CreateBody,
  ) {
    const resolved = kindOf(kind);
    const mediaId = parseMediaId(body.mediaId);
    if (mediaId === undefined) throw new ApiError(400, "invalid_request", "mediaId must be a media id such as med-12.");
    return { item: await this.editorial.create(resolved, mediaId, body.data, principal) };
  }

  /** 200 `{ changed, item }`. Optimistic on `version`; see EditorialService.save. */
  @Put(":kind/items/:id")
  async save(
    @Principal() principal: string,
    @Param("kind") kind: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(saveBody, 'Expected { version: integer, status, data: the ten editorial fields, dateKey?: "YYYY-MM-DD" | null } and nothing else.')) body: SaveBody,
  ) {
    const resolved = kindOf(kind);
    const itemId = parseEditorialId(id);
    if (itemId === undefined) throw new ApiError(404, "not_found", "No such item.");
    return this.editorial.save(resolved, itemId, { version: body.version, status: body.status, data: body.data, dateKey: body.dateKey ?? null }, principal);
  }
}
