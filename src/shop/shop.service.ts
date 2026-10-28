import { Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { DatabaseService } from "../database/database.module.js";
import { hintLedger, milesLedger, players } from "../db/schema.js";
import type { PlayerRow } from "../db/schema.js";
import { MILES_HINT_PACK } from "../rules/hints.js";

export type HintPackReceipt = { hints: number; priceMiles: number };

export type BuyHintPackOutcome =
  | { kind: "purchased"; player: PlayerRow; receipt: HintPackReceipt; replayed: boolean }
  | { kind: "no_player" }
  | { kind: "insufficient_miles" };

/**
 * Spending Miles. One transaction that first takes the player's row lock (as the Round writes do), so a
 * purchase can never build on a stale balance. Nothing is retried or overwritten.
 */
@Injectable()
export class ShopService {
  constructor(private readonly database: DatabaseService) {}

  /**
   * Buy the Co-Pilot hint pack (10 hints for 5,000 Miles). `key` is the client's Idempotency-Key and the
   * ledger ref: a key already billed returns the original receipt and charges nothing, so a retry after a
   * dropped response is safe. A different key is a new purchase.
   */
  async buyHintPack(principal: string, key: string, now: Date): Promise<BuyHintPackOutcome> {
    return this.database.withTransaction(async (tx): Promise<BuyHintPackOutcome> => {
      const [player] = await tx.select().from(players).where(eq(players.id, principal)).for("update");
      if (!player) return { kind: "no_player" };

      const [billed] = await tx
        .select({ delta: milesLedger.delta })
        .from(milesLedger)
        .where(
          and(eq(milesLedger.playerId, principal), eq(milesLedger.kind, "hint_pack"), eq(milesLedger.ref, key)),
        );
      if (billed) {
        const [granted] = await tx
          .select({ delta: hintLedger.delta })
          .from(hintLedger)
          .where(
            and(eq(hintLedger.playerId, principal), eq(hintLedger.kind, "hint_pack"), eq(hintLedger.ref, key)),
          );
        const receipt = { hints: granted?.delta ?? MILES_HINT_PACK.hints, priceMiles: -billed.delta };
        return { kind: "purchased", player, receipt, replayed: true };
      }

      if (player.miles < MILES_HINT_PACK.priceMiles) return { kind: "insufficient_miles" };

      await tx.insert(milesLedger).values({
        playerId: principal,
        delta: -MILES_HINT_PACK.priceMiles,
        kind: "hint_pack",
        ref: key,
        createdAt: now,
      });
      await tx.insert(hintLedger).values({
        playerId: principal,
        delta: MILES_HINT_PACK.hints,
        kind: "hint_pack",
        ref: key,
        createdAt: now,
      });
      const [updated] = await tx
        .update(players)
        .set({
          // Relative, like the Round credit: defence in depth if the row lock were ever lost.
          miles: sql`${players.miles} - ${MILES_HINT_PACK.priceMiles}`,
          hints: sql`${players.hints} + ${MILES_HINT_PACK.hints}`,
          version: sql`${players.version} + 1`,
          updatedAt: now,
        })
        .where(eq(players.id, principal))
        .returning();
      if (!updated) throw new Error("Player row missing after hint pack purchase.");
      return {
        kind: "purchased",
        player: updated,
        receipt: { hints: MILES_HINT_PACK.hints, priceMiles: MILES_HINT_PACK.priceMiles },
        replayed: false,
      };
    });
  }
}
