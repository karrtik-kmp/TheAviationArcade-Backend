import { Body, Controller, Get, HttpCode, Param, Patch, Post } from "@nestjs/common";
import { Principal } from "../../auth/firebase-auth.guard.js";
import { StaffOnly } from "../../auth/staff.js";
import { ApiError } from "../../common/errors.js";
import { SkipClientVersion } from "../../platform/client-version.js";
import { ContentAdminService } from "./content-admin.service.js";
import { EDIT_REQUESTS, publishRequest, versionOnlyRequest } from "./drafts.js";
import { isDocumentName } from "./documents.js";
import type { ContentDocumentName } from "./documents.js";

/** An unknown document name is a 404, like an unknown route. */
function documentName(value: string): ContentDocumentName {
  if (!isDocumentName(value)) throw new ApiError(404, "not_found", "No such endpoint.");
  return value;
}

function parse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, body: unknown, message: string): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ApiError(400, "invalid_request", message);
  return parsed.data;
}

/**
 * Staff-only editing and publishing of the published documents (slice T6, design 8): read the draft, edit it, discard it, publish
 * it. Same guard as ContentController (staff allowlist after authentication) and the same exemption from the client version gate,
 * because the website that calls it has no app build number (it also sends `X-Client: web`). The staff identity is the verified token's
 * principal and nothing in the body. Players never see a draft: only a publish changes what the manifest serves.
 */
@StaffOnly()
@SkipClientVersion()
@Controller("v1/admin/content/documents")
export class ContentAdminController {
  constructor(private readonly admin: ContentAdminService) {}

  /** Every document: the version in force, the draft revision and whether a publish would change anything. */
  @Get()
  async list() {
    return { documents: await this.admin.list() };
  }

  /** The draft of one document: its pending edits and the document a publish would write (a preview, not yet served). */
  @Get(":name/draft")
  async get(@Param("name") name: string) {
    return this.admin.get(documentName(name));
  }

  /** Edit the draft. `draftVersion` is the revision you read; a stale one is 409 `version_conflict` and nothing changes. */
  @Patch(":name/draft")
  async edit(@Principal() principal: string, @Param("name") raw: string, @Body() body: unknown) {
    const name = documentName(raw);
    const request = parse(
      EDIT_REQUESTS[name] as { safeParse(value: unknown): { success: true; data: { draftVersion: number } } | { success: false } },
      body,
      `Expected { draftVersion, ${name === "field-awards" ? "awards" : name === "clipper-cards" ? "names" : "entries"}: [...] } as documented.`,
    );
    return this.admin.edit(name, principal, request.draftVersion, request);
  }

  /** Throw away the pending edits. */
  @Post(":name/draft/discard")
  @HttpCode(200)
  async discard(@Principal() principal: string, @Param("name") raw: string, @Body() body: unknown) {
    const name = documentName(raw);
    const request = parse(versionOnlyRequest, body, "Expected { draftVersion }.");
    return this.admin.discard(name, principal, request.draftVersion);
  }

  /** Publish the draft as the next document version. 201 with the new version; the manifest changes with it. */
  @Post(":name/publish")
  @HttpCode(201)
  async publish(@Principal() principal: string, @Param("name") raw: string, @Body() body: unknown) {
    const name = documentName(raw);
    const request = parse(publishRequest, body, "Expected { draftVersion, note? }.");
    return this.admin.publish(name, principal, request.draftVersion, request.note, request.acknowledgeCardRemoval === true);
  }
}
