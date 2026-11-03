import { Controller, Get, Query } from "@nestjs/common";
import { z } from "zod";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { MediaService } from "./media.service.js";

const MEDIA_ID = /^med-([1-9][0-9]{0,14})$/;
const MAX_IDS = 50;

/**
 * `?ids=med-1,med-2`: one parameter (a repeated one arrives as an array and fails), 1 to 50 comma-separated strict ids as sent.
 * Duplicates are collapsed, keeping the first position. Unknown parameters are refused.
 */
const idsQuery = z
  .strictObject({
    ids: z
      .string()
      .transform((s) => s.split(","))
      .pipe(z.array(z.string().regex(MEDIA_ID)).min(1).max(MAX_IDS)),
  })
  .transform((q) => [...new Set(q.ids.map((id) => Number(MEDIA_ID.exec(id)![1])))]);

/**
 * Published images for players and the website (ADR-0001): any signed-in caller, no role. NOT exempt from the client version gate;
 * the website's `X-Client: web` is skipped by the gate itself, as on every other route.
 */
@Controller("v1/media")
export class MediaPublicController {
  constructor(private readonly media: MediaService) {}

  @Get()
  async published(
    @Query(new ZodValidationPipe(idsQuery, "Expected only ?ids=med-1,med-2,... with 1 to 50 media ids, each med-<n>, in one parameter.")) ids: number[],
  ) {
    return { images: await this.media.published(ids) };
  }
}
