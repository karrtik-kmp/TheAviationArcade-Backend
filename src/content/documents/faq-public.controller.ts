import { Controller, Get, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { Public } from "../../auth/public.decorator.js";
import { ApiError } from "../../common/errors.js";
import { ifNoneMatchHits } from "../../common/http-cache.js";
import { DatabaseService } from "../../database/database.module.js";
import { SkipClientVersion } from "../../platform/client-version.js";
import { documentInForce } from "./document-store.js";

/** Store, but revalidate with If-None-Match (the same header as the manifest). Errors keep the global no-store. */
export const FAQ_CACHE_CONTROL = "no-cache";

/**
 * Anonymous FAQ read for the public website (docs/plans/faq-cms.md F7), after `GET /v1/public/media` and
 * `GET /v1/public/plane-of-the-day`. The FAQ is a site document: it is not in the manifest and `GET /v1/content/documents` never serves it.
 * Public, so it is rate limited per IP (the website's server is one IP for every guest, so it caches this response on its server and
 * never calls per visitor) and an Authorization header is ignored. A guest has no app build, so the client version gate is skipped.
 * Never use `@Principal()` here (it throws on public routes).
 */
@Public()
@SkipClientVersion()
@Controller("v1/public/faq")
export class FaqPublicController {
  constructor(private readonly database: DatabaseService) {}

  @Get()
  async faq(@Req() req: Request, @Res() res: Response): Promise<void> {
    // "In force" is the one definition of the document stores: the highest version whose shape, digest and length verify.
    const found = await documentInForce(this.database.db, "faq");
    if (!found) throw new ApiError(404, "not_found", "The FAQ has not been published yet.");
    const etag = `"${found.meta.sha256}"`;
    res.setHeader("Cache-Control", FAQ_CACHE_CONTROL);
    res.setHeader("ETag", etag);
    if (ifNoneMatchHits(req.header("if-none-match"), etag)) {
      res.status(304).end();
      return;
    }
    const { format, version, categories } = found.value;
    res.status(200).json({ format, version, publishedAt: found.meta.createdAt.toISOString(), categories });
  }
}
