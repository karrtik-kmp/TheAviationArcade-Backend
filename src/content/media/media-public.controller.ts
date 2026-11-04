import { Controller, Get, Query } from "@nestjs/common";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { IDS_QUERY_MESSAGE, idsQuery } from "./media-ids-query.js";
import { MediaService } from "./media.service.js";

/**
 * Published images for players and the website (ADR-0001), signed-in route: any signed-in caller, no role. NOT exempt from the
 * client version gate; the website's `X-Client: web` is skipped by the gate itself, as on every other route. Its anonymous twin
 * for guests is `GET /v1/public/media` (MediaGuestController).
 */
@Controller("v1/media")
export class MediaPublicController {
  constructor(private readonly media: MediaService) {}

  @Get()
  async published(@Query(new ZodValidationPipe(idsQuery, IDS_QUERY_MESSAGE)) ids: number[]) {
    return { images: await this.media.published(ids) };
  }
}
