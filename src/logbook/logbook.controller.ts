import { Controller, Get, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { Principal } from "../auth/firebase-auth.guard.js";
import { ApiError } from "../common/errors.js";
import { ifNoneMatchHits } from "../common/http-cache.js";
import { LogbookService } from "./logbook.service.js";

/**
 * Per-player data that is revalidated, never reused blindly: `private` keeps it out of shared caches (the manifest is the same
 * for everyone and says plain `no-cache`), `no-cache` makes every use go through `If-None-Match`. Errors keep the global `no-store`.
 */
export const LOGBOOK_CACHE_CONTROL = "private, no-cache";

@Controller("v1/me")
export class LogbookController {
  constructor(private readonly logbook: LogbookService) {}

  /** The Pilot Logbook. 200 with an `ETag`; 304 when `If-None-Match` names the current one. Read-only. */
  @Get("logbook")
  async get(@Principal() principal: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    const header = req.header("if-none-match");
    const outcome = await this.logbook.read(principal, (etag) => ifNoneMatchHits(header, etag));
    switch (outcome.kind) {
      case "no_player":
        throw new ApiError(404, "player_not_found", "Call PUT /v1/me first.");
      case "unavailable":
        throw outcome.error;
      case "not_modified":
        res.setHeader("Cache-Control", LOGBOOK_CACHE_CONTROL);
        res.vary("Authorization"); // per player: a shared cache must key on the token
        res.setHeader("ETag", outcome.etag);
        res.status(304).end();
        return;
      case "ok":
        res.setHeader("Cache-Control", LOGBOOK_CACHE_CONTROL);
        res.vary("Authorization"); // per player: a shared cache must key on the token
        res.setHeader("ETag", outcome.etag);
        res.status(200).json({ logbook: outcome.logbook });
        return;
    }
  }
}
