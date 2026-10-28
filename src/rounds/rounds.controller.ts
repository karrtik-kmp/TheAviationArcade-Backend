import { Body, Controller, HttpCode, Param, Post } from "@nestjs/common";
import type { PipeTransform } from "@nestjs/common";
import { z } from "zod";
import { Principal } from "../auth/firebase-auth.guard.js";
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

// No body is expected; { } is tolerated because some HTTP clients always send one.
const emptyBody = z.strictObject({}).optional();

/** A non-UUID id cannot name a Round: 404 without a database round trip. */
class RoundIdPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!z.uuid().safeParse(value).success) {
      throw new ApiError(404, "round_not_found", "No such Round for this player.");
    }
    return value;
  }
}

@Controller("v1/rounds")
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
    @Param("roundId", new RoundIdPipe()) roundId: string,
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

  /** Spend this Round's one hint. No body. Idempotent: a repeat is a 200 replay and costs nothing. */
  @Post(":roundId/hint")
  @HttpCode(200)
  async hint(
    @Principal() principal: string,
    @Param("roundId", new RoundIdPipe()) roundId: string,
    @Body(new ZodValidationPipe(emptyBody, "Expected no body.")) _body: undefined,
  ) {
    const now = new Date();
    const outcome = await this.rounds.spendHint(principal, roundId, now);
    switch (outcome.kind) {
      case "not_found":
        throw new ApiError(404, "round_not_found", "No such Round for this player.");
      case "expired":
        throw new ApiError(410, "round_expired", "This Round expired.");
      case "closed":
        throw new ApiError(410, "round_closed", "This Round is no longer open.");
      case "no_hints":
        throw new ApiError(409, "insufficient_hints", "No hints left.");
      case "spent":
        return { hint: { roundId, replayed: outcome.replayed }, progress: progressView(outcome.player, now) };
    }
  }
}
