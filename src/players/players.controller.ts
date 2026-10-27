import { Body, Controller, Get, Put, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import { FirebaseAuthGuard, Principal } from "../auth/firebase-auth.guard.js";
import { ApiError } from "../common/errors.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { RANKS } from "../rules/ranks.js";
import { progressView } from "./progress-view.js";
import { PlayersService } from "./players.service.js";

const activeRankBody = z.strictObject({ rank: z.enum(RANKS) });
type ActiveRankBody = z.infer<typeof activeRankBody>;

@Controller("v1/me")
@UseGuards(FirebaseAuthGuard)
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
    const player = await this.players.getPlayer(principal);
    if (!player) throw new ApiError(404, "player_not_found", "Call PUT /v1/me first.");
    const now = new Date();
    const updated = await this.players.setActiveRank(player, body.rank, now);
    if (!updated) {
      throw new ApiError(403, "rank_not_certified", "Active Rank cannot be above Certified Rank.");
    }
    return { progress: progressView(updated, now) };
  }
}
