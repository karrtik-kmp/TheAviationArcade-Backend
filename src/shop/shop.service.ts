import { Injectable } from "@nestjs/common";
import { PlayerBalance } from "../balance/player-balance.js";
import { DatabaseService } from "../database/database.module.js";
import { withLiveStreak } from "../trips/trip-store.js";
import type { PlayerRow } from "../db/schema.js";
import { MILES_HINT_PACK } from "../rules/hints.js";

export type HintPackReceipt = { hints: number; priceMiles: number };

export type BuyHintPackOutcome =
  | { kind: "purchased"; player: PlayerRow; receipt: HintPackReceipt; replayed: boolean }
  | { kind: "no_player" }
  | { kind: "insufficient_miles" };

/**
 * Spending Miles. One transaction through PlayerBalance.update, which first takes the player's row lock (as the
 * Round writes do), so a purchase can never build on a stale balance. Nothing is retried or overwritten.
 */
@Injectable()
export class ShopService {
  constructor(
    private readonly balance: PlayerBalance,
    private readonly database: DatabaseService,
  ) {}

  /**
   * Buy the Co-Pilot hint pack (10 hints for 5,000 Miles). `key` is the client's Idempotency-Key and the
   * ledger ref: a key already billed returns the original receipt and charges nothing, so a retry after a
   * dropped response is safe. A different key is a new purchase.
   */
  async buyHintPack(principal: string, key: string, now: Date): Promise<BuyHintPackOutcome> {
    const result = await this.balance.update<{ receipt: HintPackReceipt; replayed: boolean }>(
      principal,
      now,
      async (locked) => {
        const billed = await locked.posted("miles", "hint_pack", key);
        if (billed !== null) {
          const granted = await locked.posted("hints", "hint_pack", key);
          return {
            value: { receipt: { hints: granted ?? MILES_HINT_PACK.hints, priceMiles: -billed }, replayed: true },
          };
        }
        return {
          value: {
            receipt: { hints: MILES_HINT_PACK.hints, priceMiles: MILES_HINT_PACK.priceMiles },
            replayed: false,
          },
          change: {
            postings: [
              { account: "miles", delta: -MILES_HINT_PACK.priceMiles, kind: "hint_pack", ref: key },
              { account: "hints", delta: MILES_HINT_PACK.hints, kind: "hint_pack", ref: key },
            ],
          },
        };
      },
    );
    if (result.kind === "no_player") return { kind: "no_player" };
    if (result.kind === "insufficient") return { kind: "insufficient_miles" };
    return { kind: "purchased", player: await withLiveStreak(this.database.db, result.player, now), ...result.value };
  }
}
