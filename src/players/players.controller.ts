import { Body, Controller, Delete, Get, HttpCode, Put, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { z } from "zod";
import { SkipClientVersion } from "../platform/client-version.js";
import { Principal } from "../auth/firebase-auth.guard.js";
import { ApiError } from "../common/errors.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { RANKS } from "../rules/ranks.js";
import { GuestCreationLimit } from "./guest-limit.js";
import { profileView, progressView } from "./progress-view.js";
import { PlayersService } from "./players.service.js";

const activeRankBody = z.strictObject({ rank: z.enum(RANKS) });
type ActiveRankBody = z.infer<typeof activeRankBody>;

@Controller("v1/me")
export class PlayersController {
  constructor(
    private readonly players: PlayersService,
    private readonly guestLimit: GuestCreationLimit,
  ) {}

  /**
   * Sign-in handshake: creates the player on first call, then returns progress and the profile (Callsign, guest). Idempotent.
   * A Firebase Anonymous guest's FIRST call counts against the per-IP guest limit (plan G3) before anything is written.
   */
  @Put()
  async signIn(@Principal() principal: string, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const anonymous = req.anonymous === true;
    if (anonymous && !(await this.players.getPlayer(principal))) await this.guestLimit.count(req.ip);
    const { player, created } = await this.players.ensurePlayer(principal, anonymous);
    res.status(created ? 201 : 200);
    return { progress: progressView(await this.players.live(player)), profile: profileView(player, anonymous) };
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
    await this.players.deletePlayer(principal);
  }

  @Get("progress")
  async progress(@Principal() principal: string) {
    const player = await this.players.getPlayer(principal);
    if (!player) throw new ApiError(404, "player_not_found", "Call PUT /v1/me first.");
    return { progress: progressView(await this.players.live(player)) };
  }

  @Put("active-rank")
  async setActiveRank(
    @Principal() principal: string,
    @Body(new ZodValidationPipe(activeRankBody, "Expected { rank }.")) body: ActiveRankBody,
  ) {
    const outcome = await this.players.setActiveRank(principal, body.rank);
    switch (outcome.kind) {
      case "no_player":
        throw new ApiError(404, "player_not_found", "Call PUT /v1/me first.");
      case "above_certified":
        throw new ApiError(403, "rank_not_certified", "Active Rank cannot be above Certified Rank.");
      case "set":
        return { progress: progressView(await this.players.live(outcome.player)) };
    }
  }
}
