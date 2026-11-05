import { Controller, Get, Query } from "@nestjs/common";
import { z } from "zod";
import { Public } from "../../auth/public.decorator.js";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { SkipClientVersion } from "../../platform/client-version.js";
import { EditorialService } from "./editorial.service.js";

// `timeZone` is the only key; a repeated one (an array) or any other key is a 400. The zone itself is checked by the service.
const planeQuery = z.strictObject({ timeZone: z.string().max(200).optional() });
type PlaneQuery = z.infer<typeof planeQuery>;

/**
 * Anonymous Plane of the Day read for the public website (docs/plans/website-content.md §1.2, §1.4), the second guest route
 * after `GET /v1/public/media`. Public, so it is rate limited per IP (the website's server is one IP for every guest, so it
 * caches this response on its server and never calls per visitor) and an Authorization header is ignored. A guest has no app
 * build, so the client version gate is skipped. Never use `@Principal()` here (it throws on public routes).
 */
@Public()
@SkipClientVersion()
@Controller("v1/public/plane-of-the-day")
export class EditorialPublicController {
  constructor(private readonly editorial: EditorialService) {}

  @Get()
  async planeOfTheDay(@Query(new ZodValidationPipe(planeQuery, "Expected an optional ?timeZone=<IANA zone> and nothing else.")) query: PlaneQuery) {
    return this.editorial.planeOfTheDay(query.timeZone);
  }
}
