import { Body, Controller, Headers, HttpCode, Param, Post, Res } from "@nestjs/common";
import type { PipeTransform } from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import { Principal } from "../auth/firebase-auth.guard.js";
import { ApiError } from "../common/errors.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { progressView } from "../players/progress-view.js";
import { MODULE_IDS } from "../rules/modules.js";
import { FLIGHTS_PER_TRIP, isCalendarDate } from "../rules/trips.js";
import { TripsService } from "./trips.service.js";

const openTripBody = z.strictObject({
  module: z.enum(MODULE_IDS),
  flightCount: z.literal(FLIGHTS_PER_TRIP),
  localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isCalendarDate),
  utcOffsetMinutes: z.int().min(-720).max(840),
  contentVersion: z.string().regex(/^[A-Za-z0-9._:+-]{1,64}$/),
});
type OpenTripBody = z.infer<typeof openTripBody>;

// No body is expected; { } is tolerated because some HTTP clients always send one.
const emptyBody = z.strictObject({}).optional();

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{1,128}$/;

/** The Idempotency-Key header is required (U14) and is stored on the segment, so it is checked strictly. */
function idempotencyKey(value: string | undefined): string {
  if (typeof value !== "string" || !IDEMPOTENCY_KEY.test(value)) {
    throw new ApiError(
      400,
      "invalid_request",
      "Expected an Idempotency-Key header of 1-128 characters: letters, digits, _ and -.",
    );
  }
  return value;
}

/** A non-UUID id cannot name a Flight Segment: 404 without a database round trip. */
class TripIdPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!z.uuid().safeParse(value).success) {
      throw new ApiError(404, "trip_not_found", "No such Flight Segment for this player.");
    }
    return value;
  }
}

@Controller("v1/trips")
export class TripsController {
  constructor(private readonly trips: TripsService) {}

  /** Open a Flight Segment. 201 when opened, 200 when the Idempotency-Key was already used (the segment it opened). */
  @Post()
  async open(
    @Principal() principal: string,
    @Headers("idempotency-key") rawKey: string | undefined,
    @Body(
      new ZodValidationPipe(
        openTripBody,
        "Expected { module, flightCount: 10, localDate, utcOffsetMinutes, contentVersion }.",
      ),
    )
    body: OpenTripBody,
    @Res({ passthrough: true }) res: Response,
  ) {
    const key = idempotencyKey(rawKey);
    const now = new Date();
    const outcome = await this.trips.openTrip(
      principal,
      key,
      {
        module: body.module,
        localDate: body.localDate,
        utcOffsetMinutes: body.utcOffsetMinutes,
        contentVersion: body.contentVersion,
      },
      now,
    );
    switch (outcome.kind) {
      case "no_player":
        throw new ApiError(404, "player_not_found", "Call PUT /v1/me first.");
      case "local_date_mismatch":
        throw new ApiError(
          422,
          "local_date_mismatch",
          "localDate is not the date of server time plus utcOffsetMinutes (15 minutes either side).",
        );
      case "idempotency_key_reused":
        throw new ApiError(
          422,
          "idempotency_key_reused",
          "This Idempotency-Key already opened a Flight Segment for a different module; use a new key.",
        );
      case "opened":
      case "replayed":
        res.status(outcome.kind === "opened" ? 201 : 200);
        return { trip: outcome.trip, progress: progressView(outcome.player, now) };
    }
  }

  /**
   * Complete the Flight Segment after its tenth banked Round. No body. Idempotent: a completed segment answers the same
   * lists with `replayed: true`. 409 `trip_incomplete` before ten Rounds are banked.
   */
  @Post(":tripId/complete")
  @HttpCode(200)
  async complete(
    @Principal() principal: string,
    @Param("tripId", new TripIdPipe()) tripId: string,
    @Body(new ZodValidationPipe(emptyBody, "Expected no body.")) _body: undefined,
  ) {
    const now = new Date();
    const outcome = await this.trips.completeTrip(principal, tripId, now);
    switch (outcome.kind) {
      case "not_found":
        throw new ApiError(404, "trip_not_found", "No such Flight Segment for this player.");
      case "incomplete":
        throw new ApiError(409, "trip_incomplete", "Fewer than ten Rounds of this Flight Segment are banked.");
      case "expired":
        throw new ApiError(410, "trip_expired", "This Flight Segment expired before all ten Rounds were banked.");
      case "closed":
        throw new ApiError(410, "trip_closed", "This Flight Segment was abandoned.");
      case "completed":
        return { ...outcome.completion, replayed: outcome.replayed, progress: progressView(outcome.player, now) };
    }
  }

  /** Abandon the Flight Segment. No body. Idempotent: abandoning an abandoned or expired segment is a 200 replay. */
  @Post(":tripId/abandon")
  @HttpCode(200)
  async abandon(
    @Principal() principal: string,
    @Param("tripId", new TripIdPipe()) tripId: string,
    @Body(new ZodValidationPipe(emptyBody, "Expected no body.")) _body: undefined,
  ) {
    const now = new Date();
    const outcome = await this.trips.abandonTrip(principal, tripId, now);
    switch (outcome.kind) {
      case "not_found":
        throw new ApiError(404, "trip_not_found", "No such Flight Segment for this player.");
      case "full":
        throw new ApiError(409, "trip_full", "All ten Rounds are banked; complete the Flight Segment instead.");
      case "closed":
        throw new ApiError(410, "trip_closed", "This Flight Segment was completed.");
      case "abandoned":
        return { trip: outcome.trip, replayed: outcome.replayed, progress: progressView(outcome.player, now) };
    }
  }
}
