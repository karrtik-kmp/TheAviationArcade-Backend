import { Body, Controller, Headers, HttpCode, Post } from "@nestjs/common";
import { z } from "zod";
import { Principal } from "../auth/firebase-auth.guard.js";
import { ApiError } from "../common/errors.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { progressView } from "../players/progress-view.js";
import { ShopService } from "./shop.service.js";

// No body is expected; { } is tolerated because some HTTP clients always send one.
const emptyBody = z.strictObject({}).optional();

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{1,128}$/;

/** The Idempotency-Key header is required and becomes the ledger ref, so it is checked strictly. */
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

@Controller("v1/shop")
export class ShopController {
  constructor(private readonly shop: ShopService) {}

  /** Buy the Co-Pilot hint pack with Miles. Idempotent per Idempotency-Key: a repeat is a 200 replay. */
  @Post("miles-hint-pack")
  @HttpCode(200)
  async buyHintPack(
    @Principal() principal: string,
    @Headers("idempotency-key") rawKey: string | undefined,
    @Body(new ZodValidationPipe(emptyBody, "Expected no body.")) _body: undefined,
  ) {
    const now = new Date();
    const outcome = await this.shop.buyHintPack(principal, idempotencyKey(rawKey), now);
    switch (outcome.kind) {
      case "no_player":
        throw new ApiError(404, "player_not_found", "Call PUT /v1/me first.");
      case "insufficient_miles":
        throw new ApiError(409, "insufficient_miles", "Not enough Miles for the hint pack.");
      case "purchased":
        return {
          purchase: { ...outcome.receipt, replayed: outcome.replayed },
          progress: progressView(outcome.player, now),
        };
    }
  }
}
