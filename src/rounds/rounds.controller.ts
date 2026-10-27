import { Body, Controller, HttpCode, Param, Post, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { FirebaseAuthGuard, Principal } from "../auth/firebase-auth.guard.js";
import { ApiError } from "../common/errors.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { progressView } from "../players/progress-view.js";
import { MODULE_IDS } from "../rules/modules.js";
import { RoundsService } from "./rounds.service.js";

const startRoundBody = z.strictObject({ module: z.enum(MODULE_IDS) });
type StartRoundBody = z.infer<typeof startRoundBody>;

const roundResultBody = z.strictObject({
  finished: z.boolean(),
  errorCount: z.int().min(0).max(1000),
  usedHint: z.boolean(),
  timeRemainingFraction: z.number().min(0).max(1),
});
type RoundResultBody = z.infer<typeof roundResultBody>;

@Controller("v1/rounds")
@UseGuards(FirebaseAuthGuard)
export class RoundsController {
  constructor(private readonly rounds: RoundsService) {}

  @Post()
  async start(
    @Principal() principal: string,
    @Body(new ZodValidationPipe(startRoundBody, "Expected { module }.")) body: StartRoundBody,
  ) {
    const round = await this.rounds.issueRound(principal, body.module, new Date());
    if (!round) throw new ApiError(404, "player_not_found", "Call PUT /v1/me first.");
    return { round };
  }

  @Post(":roundId/result")
  @HttpCode(200)
  async result(
    @Principal() principal: string,
    @Param("roundId") roundId: string,
    @Body(
      new ZodValidationPipe(
        roundResultBody,
        "Expected { finished, errorCount, usedHint, timeRemainingFraction }.",
      ),
    )
    body: RoundResultBody,
  ) {
    const now = new Date();
    const outcome = await this.rounds.completeRound(principal, roundId, body, now);
    switch (outcome.kind) {
      case "not_found":
        throw new ApiError(404, "round_not_found", "No such Round for this player.");
      case "expired":
        throw new ApiError(410, "round_expired", "This Round expired before its result arrived.");
      case "closed":
        throw new ApiError(410, "round_closed", "This Round was superseded by a newer one.");
      case "too_fast":
        throw new ApiError(
          429,
          "round_too_fast",
          "Result arrived too soon after the Round started. Retry shortly.",
          { "Retry-After": "3" },
        );
      case "completed": {
        const { award, player, promotion, replayed } = outcome.result;
        return { award, promotion, replayed, progress: progressView(player, now) };
      }
    }
  }
}
