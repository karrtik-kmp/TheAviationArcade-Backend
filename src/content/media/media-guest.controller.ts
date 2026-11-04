import { Controller, Get, Query } from "@nestjs/common";
import { Public } from "../../auth/public.decorator.js";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { SkipClientVersion } from "../../platform/client-version.js";
import { IDS_QUERY_MESSAGE, idsQuery } from "./media-ids-query.js";
import { MediaService } from "./media.service.js";

/**
 * Anonymous twin of `GET /v1/media` for guests on the public website (user ruling 2026-11-04, ADR-0001 §8 amendment): published
 * images only, the same signed 24 h links, no owner or principal. Public, so it is rate limited per IP, and an Authorization
 * header is ignored. A guest has no app build, so the client version gate is skipped. Never use `@Principal()` here (it throws
 * on public routes).
 */
@Public()
@SkipClientVersion()
@Controller("v1/public/media")
export class MediaGuestController {
  constructor(private readonly media: MediaService) {}

  @Get()
  async published(@Query(new ZodValidationPipe(idsQuery, IDS_QUERY_MESSAGE)) ids: number[]) {
    return { images: await this.media.published(ids) };
  }
}
