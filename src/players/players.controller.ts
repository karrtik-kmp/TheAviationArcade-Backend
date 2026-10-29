import { Body, Controller, Delete, Get, HttpCode, Put, Res } from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import { SkipClientVersion } from "../platform/client-version.js";
import { Principal } from "../auth/firebase-auth.guard.js";
import { ApiError } from "../common/errors.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { RANKS } from "../rules/ranks.js";
import { progressView } from "./progress-view.js";
import { PlayersService } from "./players.service.js";

const activeRankBody = z.strictObject({ rank: z.enum(RANKS) });
type ActiveRankBody = z.infer<typeof activeRankBody>;

@Controller("v1/me")
export class PlayersController {
  constructor(private readonly players: PlayersService) {}

  /** Sign-in handshake: creates the player on first call, then returns progress. Idempotent. */
  @Put()
  async signIn(@Principal() principal: string, @Res({ passthrough: true }) res: Response) {
    const now = new Date();
    const { player, created } = await this.players.ensurePlayer(principal, now);
    res.status(created ? 201 : 200);
    return { progress: progressView(player, now) };
  }

  /**
   * Account deletion (App Store requirement). Erases this backend's data only; the app deletes the
   * Firebase account itself, since the backend holds no Firebase admin credentials. Idempotent: 204
   * whether or not a player existed, so a retry after a dropped response succeeds. A later PUT /v1/me
   * with a still-valid token starts a fresh player at zero.
   */
  // App Store: deletion must work for outdated clients, so the version gate does not apply.
  @SkipClientVersion()
  @Delete()
  @HttpCode(204)
  async deleteAccount(@Principal() principal: string): Promise<void> {
    await this.players.deletePlayer(principal, new Date());
  }

  @Get("progress")
  async progress(@Principal() principal: string) {
    const player = await this.players.getPlayer(principal);
    if (!player) throw new ApiError(404, "player_not_found", "Call PUT /v1/me first.");
    return { progress: progressView(player, new Date()) };
  }

  @Put("active-rank")
  async setActiveRank(
    @Principal() principal: string,
    @Body(new ZodValidationPipe(activeRankBody, "Expected { rank }.")) body: ActiveRankBody,
  ) {
    const now = new Date();
    const outcome = await this.players.setActiveRank(principal, body.rank, now);
    switch (outcome.kind) {
      case "no_player":
        throw new ApiError(404, "player_not_found", "Call PUT /v1/me first.");
      case "above_certified":
        throw new ApiError(403, "rank_not_certified", "Active Rank cannot be above Certified Rank.");
      case "set":
        return { progress: progressView(outcome.player, now) };
    }
  }
}
