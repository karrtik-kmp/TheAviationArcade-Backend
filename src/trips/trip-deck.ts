import { Logger } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { compareIds } from "../content/content-modules.js";
import { peekGridBoard, pruneGridBoardMemo, pruneGridBoardMemoAtRank, rowToGridBoard } from "../content/grid-boards.js";
import type { GridWireBoard } from "../content/grid-boards.js";
import type { Tx } from "../database/database.module.js";
import { contentItems, tripDecks } from "../db/schema.js";
import type { ModuleId } from "../rules/modules.js";
import { drawGridBoards } from "../rules/grid-draw.js";
import type { Rank } from "../rules/ranks.js";

/**
 * The stored Trip deck (migration 0030, docs/plans/code-search.md section G). Code Search only: `grid.v1`, ten boards drawn by
 * `grid-draw.v1` from approved `content_items` at the Trip's rank, written with the Trip and never changed, so later edits,
 * retires or imports cannot alter a Trip in flight and a replay returns the same boards. Every function runs inside the caller's
 * transaction (the player row is already locked); nothing here touches the network.
 */

/** Only Code Search ever gets a deck (grid.v1), and only while the dev switch lists it. */
export function dealsDeck(module: ModuleId, dealFromItems: readonly string[]): boolean {
  return module === "code-search" && dealFromItems.includes(module);
}

type DeckElement = { itemId: string; itemVersion: number; board: GridWireBoard };

const logger = new Logger("TripDeck");
const warned = new Set<string>();

/**
 * Draw and store the deck for a Trip that was just inserted. True when ten boards were stored; false = client mode (fewer
 * than ten dealable boards at the rank; logged once per process per rank).
 *
 * The validated boards come from the one `grid-boards` memo (`id:version`). This open's pool is built from a LOCAL map filled
 * before and after its own `data` read, so a concurrent open that prunes the shared memo meanwhile cannot shrink it; the prune
 * touches only this rank's entries.
 */
export async function dealCodeSearchDeck(tx: Tx, tripId: string, rank: Rank, now: Date): Promise<boolean> {
  const listed = await tx
    .select({ id: contentItems.id, version: contentItems.version })
    .from(contentItems)
    .where(and(eq(contentItems.module, "code-search"), eq(contentItems.status, "approved"), eq(contentItems.rank, rank)));
  listed.sort((a, b) => compareIds(a.id, b.id));

  const keyOf = (row: { id: string; version: number }) => `${row.id}:${row.version}`;
  const boards = new Map<string, GridWireBoard | undefined>();
  const misses: typeof listed = [];
  for (const row of listed) {
    const hit = peekGridBoard(row.id, row.version, rank);
    if (hit) boards.set(keyOf(row), hit.board);
    else misses.push(row);
  }
  if (misses.length > 0) {
    const fetched = await tx
      .select({ id: contentItems.id, version: contentItems.version, data: contentItems.data })
      .from(contentItems)
      .where(
        and(
          eq(contentItems.module, "code-search"),
          eq(contentItems.status, "approved"),
          eq(contentItems.rank, rank),
          inArray(
            contentItems.id,
            misses.map((row) => row.id),
          ),
        ),
      );
    const byId = new Map(fetched.map((row) => [row.id, row]));
    for (const miss of misses) {
      const row = byId.get(miss.id);
      // A row that changed between the two reads is not dealt this time.
      if (!row || row.version !== miss.version) continue;
      boards.set(keyOf(miss), rowToGridBoard({ id: row.id, rank, version: row.version, data: row.data }));
    }
  }
  pruneGridBoardMemoAtRank(rank, new Set(listed.map(keyOf)));

  const pool: { id: string; rank: Rank; version: number; board: GridWireBoard }[] = [];
  for (const row of listed) {
    const board = boards.get(keyOf(row));
    if (board) pool.push({ id: row.id, rank, version: row.version, board });
  }

  const drawn = drawGridBoards(pool, rank, tripId);
  if (drawn.length === 0) {
    if (!warned.has(rank)) {
      warned.add(rank);
      logger.warn(`Code Search at ${rank}: ${pool.length} dealable boards (10 needed); Trips open in client mode.`);
    }
    return false;
  }
  const deck: DeckElement[] = drawn.map((entry) => ({ itemId: entry.id, itemVersion: entry.version, board: entry.board }));
  await tx.insert(tripDecks).values({ tripId, format: "grid.v1", deck, createdAt: now });
  return true;
}

/** The Trip's stored boards in deal order, or undefined when it has no deck (client mode). */
export async function readCodeSearchBoards(tx: Tx, tripId: string): Promise<GridWireBoard[] | undefined> {
  const [row] = await tx.select({ format: tripDecks.format, deck: tripDecks.deck }).from(tripDecks).where(eq(tripDecks.tripId, tripId));
  if (!row || row.format !== "grid.v1") return undefined;
  return deckToBoards(row.deck);
}

/**
 * The one mapper from a stored deck to the response boards, for the open and the replay. jsonb does not keep key order, so each
 * board is rebuilt in Unity's order (`ApiWireModels.cs` CodeSearchBoardWire): id, width, height, letters, durationSeconds,
 * clueMode, targets[{ airportId, code, clue, cityClue, cells[{ row, column }] }].
 */
export function deckToBoards(deck: unknown): GridWireBoard[] {
  if (!Array.isArray(deck)) throw new Error("Stored Trip deck is not a list.");
  return (deck as DeckElement[]).map(({ board }) => ({
    id: board.id,
    width: board.width,
    height: board.height,
    letters: board.letters,
    durationSeconds: board.durationSeconds,
    clueMode: board.clueMode,
    targets: board.targets.map((t) => ({
      airportId: t.airportId,
      code: t.code,
      clue: t.clue,
      cityClue: t.cityClue,
      cells: t.cells.map((c) => ({ row: c.row, column: c.column })),
    })),
  }));
}

/** Test hook: forget every memoised board and the once-per-rank warnings (rows deleted and re-inserted at the same version). */
export function resetTripDeckCaches(): void {
  pruneGridBoardMemo(new Set());
  warned.clear();
}
