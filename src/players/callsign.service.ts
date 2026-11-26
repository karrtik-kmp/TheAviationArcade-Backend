import { Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { PlayerBalance } from "../balance/player-balance.js";
import { ApiError } from "../common/errors.js";
import { DatabaseService } from "../database/database.module.js";
import { players } from "../db/schema.js";
import { CALLSIGN_CHANGE_COOLDOWN_MS, CALLSIGN_RAW_MAX, isReservedCallsign, normalizeCallsign } from "./callsign-rules.js";

export type CallsignStatus = "available" | "yours" | "taken" | "reserved" | "invalid";

export type CallsignAvailability = { value: string; normalized: string; available: boolean; status: CallsignStatus };

export type CallsignClaim = { callsign: string; claimedAt: string; changed: boolean };

function taken(): ApiError {
  return new ApiError(409, "callsign_taken", "That Callsign is not available.");
}

/** Callsigns (docs/plans/guest-callsign.md C1). Reads here; every write goes through PlayerBalance.setCallsign (invariant 14). */
@Injectable()
export class CallsignService {
  constructor(
    private readonly database: DatabaseService,
    private readonly balance: PlayerBalance,
  ) {}

  /** Never throws for the value: a bad one is `invalid`. Needs no player row. `normalized` is "" when invalid. */
  async availability(principal: string, raw: string): Promise<CallsignAvailability> {
    const value = raw.slice(0, CALLSIGN_RAW_MAX);
    const normalized = normalizeCallsign(raw);
    if (normalized === null) return { value, normalized: "", available: false, status: "invalid" };
    if (isReservedCallsign(normalized)) return { value, normalized, available: false, status: "reserved" };
    const [holder] = await this.database.db.select({ id: players.id }).from(players).where(eq(players.callsign, normalized));
    if (!holder) return { value, normalized, available: true, status: "available" };
    if (holder.id === principal) return { value, normalized, available: true, status: "yours" };
    return { value, normalized, available: false, status: "taken" };
  }

  async claim(principal: string, raw: string): Promise<CallsignClaim> {
    const normalized = normalizeCallsign(raw);
    if (normalized === null) {
      throw new ApiError(422, "callsign_invalid", "A Callsign is 3 to 16 letters (A-Z) or digits.");
    }
    if (isReservedCallsign(normalized)) throw taken();
    const outcome = await this.balance.setCallsign(principal, normalized, CALLSIGN_CHANGE_COOLDOWN_MS);
    switch (outcome.kind) {
      case "no_player":
        throw new ApiError(404, "player_not_found", "Call PUT /v1/me first.");
      case "taken":
        throw taken();
      case "too_soon":
        throw new ApiError(
          409,
          "callsign_change_too_soon",
          "The Callsign was changed recently.",
          {},
          { changeableAt: outcome.changeableAt.toISOString() },
        );
      case "unchanged":
        return { callsign: outcome.callsign, claimedAt: outcome.claimedAt.toISOString(), changed: false };
      case "set":
        return { callsign: outcome.callsign, claimedAt: outcome.claimedAt.toISOString(), changed: true };
    }
  }
}
