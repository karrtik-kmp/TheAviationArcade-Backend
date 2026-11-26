import { Body, Controller, Get, HttpCode, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { Principal } from "../auth/firebase-auth.guard.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { CallsignService } from "./callsign.service.js";

// Strict: identity comes from the token only (the retired Worker's `deviceId` is gone). The format is checked by the service (422).
const claimBody = z.strictObject({ callsign: z.string().max(64) });
type ClaimBody = z.infer<typeof claimBody>;

/**
 * Callsigns (0.34.0, docs/plans/guest-callsign.md C1): any signed-in player, guest or not. Keeps the retired Worker's paths and
 * availability shape (Unity HttpCallsignService). The usual per-principal rate limit applies; the app debounces typing by 500 ms.
 */
@Controller("v1/callsigns")
export class CallsignsController {
  constructor(private readonly callsigns: CallsignService) {}

  @Get(":value/availability")
  availability(@Principal() principal: string, @Param("value") value: string) {
    return this.callsigns.availability(principal, value);
  }

  /** Claim or change the caller's Callsign. 200 with `changed: false` when the caller already holds it. */
  @Post("claim")
  @HttpCode(200)
  claim(@Principal() principal: string, @Body(new ZodValidationPipe(claimBody, "Expected { callsign }.")) body: ClaimBody) {
    return this.callsigns.claim(principal, body.callsign);
  }
}
