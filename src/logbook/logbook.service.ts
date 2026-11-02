import { Injectable } from "@nestjs/common";
import { and, asc, desc, eq } from "drizzle-orm";
import { ApiError } from "../common/errors.js";
import { DatabaseService } from "../database/database.module.js";
import { playerClipperCards, playerCounters, playerFieldAwards, players, trips } from "../db/schema.js";
import type { CardModule } from "../rules/clipper-cards.js";
import type { FieldAwardId } from "../rules/field-awards.js";
import { EMPTY_COUNTERS } from "../rules/trips.js";
import { catalogInForce } from "../trips/catalog-in-force.js";
import { toCounters } from "../trips/counters-store.js";
import { summaryOf } from "../trips/trip-completion.js";
import { RECENT_TRIPS, buildLogbook, logbookEtag } from "./logbook.js";
import type { Logbook } from "./logbook.js";

export type LogbookOutcome =
  | { kind: "ok"; etag: string; logbook: Logbook }
  | { kind: "not_modified"; etag: string }
  | { kind: "no_player" }
  /** The content documents are not seeded yet: the same retryable 503 `complete` answers. */
  | { kind: "unavailable"; error: ApiError };

/**
 * `GET /v1/me/logbook` (slice T5): ONE read-only REPEATABLE READ transaction, so the player row, the counters, the
 * segments, the Cards, the earned awards and the catalog documents all come from a single snapshot (a completion committing
 * in between is seen whole or not at all, and the ETag always names the body it came with). No lock is taken and nothing is
 * written, so a read can neither wait behind a Round nor bump any counter. The ETag is decided first from the player row and
 * the catalog versions alone; a matching `If-None-Match` stops there (a 304 reads two small things, not the history).
 *
 * Response size is bounded: 20 segment rows, exactly 28 awards, a fixed set of counters, and one row per distinct Clipper
 * Card the player holds. Cards are the only list that grows, and only with content: a Card key exists only for a commercial
 * family the key gate admits (23 today) or a Military question's answer, and the clipper-cards document caps the whole set at
 * 5,000 Cards. Roughly 150 bytes per Card: about 8 KB today (23 + 27 distinct answers) and under 1 MB at the cap.
 */
@Injectable()
export class LogbookService {
  constructor(private readonly database: DatabaseService) {}

  async read(principal: string, notModified: (etag: string) => boolean): Promise<LogbookOutcome> {
    return this.database.withTransaction(
      async (tx): Promise<LogbookOutcome> => {
        const [player] = await tx
          .select({ id: players.id, createdAt: players.createdAt, logbookVersion: players.logbookVersion })
          .from(players)
          .where(eq(players.id, principal));
        if (!player) return { kind: "no_player" };

        let catalog: Awaited<ReturnType<typeof catalogInForce>>;
        try {
          catalog = await catalogInForce(tx);
        } catch (error) {
          // Returned, not thrown: a thrown error would make withTransaction discard a healthy pooled connection.
          if (error instanceof ApiError) return { kind: "unavailable", error };
          throw error;
        }
        const etag = logbookEtag({
          playerId: player.id,
          createdAt: player.createdAt,
          logbookVersion: player.logbookVersion,
          awardsVersion: catalog.version,
          tagsVersion: catalog.tagsVersion,
        });
        if (notModified(etag)) return { kind: "not_modified", etag };

        const [counterRow] = await tx.select().from(playerCounters).where(eq(playerCounters.playerId, principal));
        const tripRows = await tx
          .select()
          .from(trips)
          .where(and(eq(trips.playerId, principal), eq(trips.status, "completed")))
          .orderBy(desc(trips.closedAt), desc(trips.id))
          .limit(RECENT_TRIPS);
        const cardRows = await tx
          .select()
          .from(playerClipperCards)
          .where(eq(playerClipperCards.playerId, principal))
          .orderBy(asc(playerClipperCards.firstCollectedAt), asc(playerClipperCards.cardKey));
        const awardRows = await tx.select().from(playerFieldAwards).where(eq(playerFieldAwards.playerId, principal));

        const logbook = buildLogbook({
          logbookVersion: player.logbookVersion,
          counters: counterRow ? toCounters(counterRow) : EMPTY_COUNTERS,
          recentTrips: tripRows.map((row) => {
            const s = summaryOf(row);
            return {
              tripId: s.tripId,
              module: s.module,
              localDate: s.localDate,
              flights: s.flights,
              correct: s.correct,
              miles: s.miles,
              statusPoints: s.statusPoints,
              completedAt: s.completedAt,
            };
          }),
          cards: cardRows.map((row) => ({
            key: row.cardKey,
            module: row.module as CardModule,
            timesIdentified: row.timesIdentified,
            everPerfect: row.everPerfect,
            everHintFree: row.everHintFree,
            fastestCorrectMs: row.fastestCorrectMs,
            firstCollectedAt: row.firstCollectedAt,
          })),
          earned: new Map(awardRows.map((row) => [row.awardId as FieldAwardId, row.earnedAt])),
          catalog,
        });
        return { kind: "ok", etag, logbook };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }
}
