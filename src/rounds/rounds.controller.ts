import { Body, Controller, HttpCode, Param, Post } from "@nestjs/common";
import type { PipeTransform } from "@nestjs/common";
import { z } from "zod";
import { Principal } from "../auth/firebase-auth.guard.js";
import { ApiError } from "../common/errors.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { progressView } from "../players/progress-view.js";
import { RoundsService } from "./rounds.service.js";

// The segment id is validated as a UUID in the handler: anything else cannot name a Flight Segment (404 trip_not_found).
const startRoundBody = z.strictObject({ tripId: z.string().min(1).max(64) });
type StartRoundBody = z.infer<typeof startRoundBody>;

const roundResultBody = z.strictObject({
  finished: z.boolean(),
  errorCount: z.int().min(0).max(1000),
  usedHint: z.boolean(),
  timeRemainingFraction: z.number().min(0).max(1),
  // Flight facts (ADR-0008 section 2). The module rules (which modules take a key, the commercial gate) run in the service.
  aircraftKey: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
    .nullable(),
  answerMs: z.int().min(0).max(1_800_000),
  attempts: z.int().min(0).max(1000),
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

  /** Issue the next Round of an open Flight Segment. Module, rank and Pleasure Cruise come from the segment. */
  @Post()
  async start(
    @Principal() principal: string,
    @Body(new ZodValidationPipe(startRoundBody, "Expected { tripId }.")) body: StartRoundBody,
  ) {
    if (!z.uuid().safeParse(body.tripId).success) {
      throw new ApiError(404, "trip_not_found", "No such Flight Segment for this player.");
    }
    const outcome = await this.rounds.issueRound(principal, body.tripId, new Date());
    switch (outcome.kind) {
      case "no_player":
        throw new ApiError(404, "player_not_found", "Call PUT /v1/me first.");
      case "trip_not_found":
        throw new ApiError(404, "trip_not_found", "No such Flight Segment for this player.");
      case "trip_full":
        throw new ApiError(409, "trip_full", "All ten Rounds of this Flight Segment are banked; complete it.");
      case "trip_expired":
        throw new ApiError(410, "trip_expired", "This Flight Segment expired (30 minutes without activity).");
      case "trip_closed":
        throw new ApiError(410, "trip_closed", "This Flight Segment was completed or abandoned.");
      case "issued":
        return { round: outcome.round };
    }
  }

  @Post(":roundId/result")
  @HttpCode(200)
  async result(
    @Principal() principal: string,
    @Param("roundId", new RoundIdPipe()) roundId: string,
    @Body(
      new ZodValidationPipe(
        roundResultBody,
        "Expected { finished, errorCount, usedHint, timeRemainingFraction, aircraftKey, answerMs, attempts }.",
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
      case "trip_expired":
        throw new ApiError(410, "trip_expired", "This Round's Flight Segment expired (30 minutes without activity).");
      case "invalid_facts":
        throw new ApiError(400, "invalid_request", `Flight facts rejected: ${outcome.reason}`);
      case "too_fast":
        throw new ApiError(
          429,
          "round_too_fast",
          "Result arrived too soon after the Round started. Retry shortly.",
          { "Retry-After": "3" },
        );
      case "completed": {
        const { award, player, promotion, replayed, hintGrants, trip } = outcome.result;
        return { award, promotion, replayed, hintGrants, trip, progress: progressView(player, now) };
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
