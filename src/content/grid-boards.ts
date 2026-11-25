import { CODE_SEARCH_LADDER, MAX_GRID_SIDE } from "../rules/code-search-ladder.js";
import type { Rank } from "../rules/ranks.js";
import {
  GRID_DIRECTIONS,
  isCanonicalCode,
  isGridDirection,
  makePuzzle,
  makeTarget,
  step,
  upperInvariant,
  validatePuzzle,
  type GridDirection,
  type WordGridPuzzle,
} from "../rules/word-grid.js";

/**
 * Code Search boards as stored (`content_items.data`) and as sent (the Trip open response). Pure: no Nest, no I/O.
 * The stored form is the master pack's record minus `id` and `rank`; the wire form is Unity `ApiWireModels.cs`
 * `CodeSearchBoardWire` / `CodeSearchTargetWire` / `GridCellWire`, key order as listed there.
 */

export type StoredGridTarget = {
  airportId: string;
  code: string;
  clue: string;
  /** True when this target's FIND entry shows the city (the clue) instead of the code. */
  city: boolean;
  row: number;
  column: number;
  direction: GridDirection;
};

export type StoredGridBoard = {
  letters: string;
  targets: StoredGridTarget[];
};

export type GridWireCell = { row: number; column: number };
export type GridWireTarget = { airportId: string; code: string; clue: string; cityClue: boolean; cells: GridWireCell[] };
export type GridClueMode = "Code" | "City" | "Mixed";
export type GridWireBoard = {
  id: string;
  width: number;
  height: number;
  letters: string;
  durationSeconds: number;
  clueMode: GridClueMode;
  targets: GridWireTarget[];
};

/** The pack's board ids, `CS-<rank prefix>-<4 digits>`. */
export const CODE_SEARCH_ID = /^CS-(TR|FO|CA|CH|CP)-\d{4}$/;

export const CODE_SEARCH_ID_PREFIX: Readonly<Record<string, Rank>> = {
  TR: "trainee",
  FO: "first-officer",
  CA: "captain",
  CH: "check-airman",
  CP: "chief-pilot",
};

const BOARD_KEYS = ["letters", "targets"] as const;
const TARGET_KEYS = ["airportId", "code", "clue", "city", "row", "column", "direction"] as const;
/** A code longer than this cannot sit in any grid; refused before a path is built from its length. */
const MAX_CODE_LENGTH = 16;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keyProblems(value: Record<string, unknown>, keys: readonly string[], where: string): string[] {
  const problems: string[] = [];
  for (const key of Object.keys(value)) if (!keys.includes(key)) problems.push(`${where} has an unknown key '${key}'.`);
  for (const key of keys) if (!Object.hasOwn(value, key)) problems.push(`${where} is missing '${key}'.`);
  return problems;
}

/** Strict shape check; returns the typed board, or the problems. Nothing is normalised. */
function parseBoard(data: unknown): { board: StoredGridBoard; side: number } | { problems: string[] } {
  if (!isRecord(data)) return { problems: ["A board must be an object with letters and targets."] };
  const problems = keyProblems(data, BOARD_KEYS, "The board");
  const { letters, targets } = data;

  let side = 0;
  if (typeof letters !== "string" || letters.length === 0) problems.push("letters must be a non-empty string.");
  else {
    side = Math.sqrt(letters.length);
    if (!Number.isInteger(side) || side < 1 || side > MAX_GRID_SIDE) {
      problems.push(`letters must fill a square grid with a side of 1 to ${MAX_GRID_SIDE}; got ${letters.length} letters.`);
      side = 0;
    } else if (letters !== upperInvariant(letters)) problems.push("letters must be stored in upper case.");
  }

  const parsed: StoredGridTarget[] = [];
  if (!Array.isArray(targets)) problems.push("targets must be a list.");
  else {
    targets.forEach((raw: unknown, t) => {
      const where = `Target ${t}`;
      if (!isRecord(raw)) {
        problems.push(`${where} must be an object.`);
        return;
      }
      const before = problems.length;
      problems.push(...keyProblems(raw, TARGET_KEYS, where));
      if (typeof raw.airportId !== "string") problems.push(`${where} airportId must be a string.`);
      if (typeof raw.code !== "string") problems.push(`${where} code must be a string.`);
      else if (raw.code.length > MAX_CODE_LENGTH) problems.push(`${where} code is longer than ${MAX_CODE_LENGTH} letters.`);
      else if (!isCanonicalCode(raw.code)) problems.push(`${where} code must be stored trimmed and upper case.`);
      if (typeof raw.clue !== "string") problems.push(`${where} clue must be a string.`);
      else if (raw.clue !== raw.clue.trim()) problems.push(`${where} clue must be stored trimmed.`);
      if (typeof raw.city !== "boolean") problems.push(`${where} city must be true or false.`);
      if (!Number.isSafeInteger(raw.row)) problems.push(`${where} row must be an integer.`);
      if (!Number.isSafeInteger(raw.column)) problems.push(`${where} column must be an integer.`);
      if (!isGridDirection(raw.direction)) problems.push(`${where} direction must be one of ${GRID_DIRECTIONS.join(", ")}.`);
      if (problems.length === before) parsed.push(raw as unknown as StoredGridTarget);
    });
  }
  if (problems.length > 0) return { problems };
  return { board: { letters: letters as string, targets: parsed }, side };
}

function cellsOf(target: StoredGridTarget) {
  const start = { row: target.row, column: target.column };
  const cells = [];
  for (let i = 0; i < target.code.length; i++) cells.push(step(start, target.direction, i));
  return cells;
}

function puzzleOf(id: string, board: StoredGridBoard, side: number): WordGridPuzzle {
  return makePuzzle(
    id,
    side,
    side,
    board.letters,
    board.targets.map((t) => makeTarget(t.airportId, t.code, t.clue, cellsOf(t))),
  );
}

/**
 * The rank-free rules for a stored board: strict shape (no unknown keys, canonical strings, a square of A-Z with a
 * side of 1 to 8) then the puzzle rules with all eight directions, in Unity's words. Empty when valid.
 */
export function checkBoardPayload(data: unknown): string[] {
  const parsed = parseBoard(data);
  if ("problems" in parsed) return parsed.problems;
  return validatePuzzle(puzzleOf("board", parsed.board, parsed.side));
}

/** The rank an id's prefix names, or undefined when the id is not a Code Search id. */
export function rankOfBoardId(id: string): Rank | undefined {
  const match = CODE_SEARCH_ID.exec(id);
  return match ? CODE_SEARCH_ID_PREFIX[match[1] as string] : undefined;
}

/**
 * The rank-fit rules: the id prefix names `rank`; side, target count, city count and directions are the rung's.
 * Reports only fit problems (run `checkBoardPayload` for the rest); a misshapen payload returns its shape problems.
 */
export function checkBoardFit(id: string, rank: Rank, data: unknown): string[] {
  const problems: string[] = [];
  if (!CODE_SEARCH_ID.test(id)) problems.push(`Board id '${id}' must look like CS-TR-0001 (TR, FO, CA, CH or CP).`);
  else if (rankOfBoardId(id) !== rank) problems.push(`Board '${id}' has an id prefix that does not match its rank.`);

  const parsed = parseBoard(data);
  if ("problems" in parsed) return [...problems, ...parsed.problems];
  const rung = CODE_SEARCH_LADDER[rank];
  const { board, side } = parsed;
  if (side !== rung.gridSide || board.targets.length !== rung.targetCount) {
    problems.push(`Board '${id}' does not fit its rank's grid or target count.`);
  }
  const cities = board.targets.filter((t) => t.city).length;
  if (cities !== rung.cityClues) problems.push(`Board '${id}' shows ${cities} cities; its rank shows ${rung.cityClues}.`);

  // Only the direction messages differ between the two runs: the rest are payload problems, not fit.
  const puzzle = puzzleOf(id, board, side);
  const everywhere = new Set(validatePuzzle(puzzle));
  for (const message of validatePuzzle(puzzle, rung.directions)) if (!everywhere.has(message)) problems.push(message);
  return problems;
}

/** The wire board for a stored board that passed `checkBoardPayload` and `checkBoardFit`. */
export function toWireBoard(id: string, rank: Rank, data: StoredGridBoard): GridWireBoard {
  const rung = CODE_SEARCH_LADDER[rank];
  const cities = data.targets.filter((t) => t.city).length;
  const side = Math.sqrt(data.letters.length);
  return {
    id,
    width: side,
    height: side,
    letters: data.letters,
    durationSeconds: rung.durationSeconds,
    clueMode: cities === 0 ? "Code" : cities === data.targets.length ? "City" : "Mixed",
    targets: data.targets.map((t) => ({
      airportId: t.airportId,
      code: t.code,
      clue: t.clue,
      cityClue: t.city,
      cells: cellsOf(t).map((c) => ({ row: c.row, column: c.column })),
    })),
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

type Memo = { readonly rank: Rank; readonly board: GridWireBoard | undefined };
const memo = new Map<string, Memo>();

/**
 * A validated, rank-fit, frozen wire board for an item row, or undefined when any check fails (a misfit is not dealt).
 * Memoised by `id:version` so a Trip open does not re-validate hundreds of boards; `pruneGridBoardMemo` evicts.
 */
export function rowToGridBoard(row: { id: string; rank: Rank; version: number; data: unknown }): GridWireBoard | undefined {
  const key = `${row.id}:${row.version}`;
  const hit = memo.get(key);
  if (hit && hit.rank === row.rank) return hit.board;
  let board: GridWireBoard | undefined;
  if (checkBoardPayload(row.data).length === 0 && checkBoardFit(row.id, row.rank, row.data).length === 0) {
    board = deepFreeze(toWireBoard(row.id, row.rank, row.data as StoredGridBoard));
  }
  memo.set(key, { rank: row.rank, board });
  return board;
}

/** Drops every memo entry whose `id:version` key is not in `keep`. */
export function pruneGridBoardMemo(keep: ReadonlySet<string>): void {
  for (const key of [...memo.keys()]) if (!keep.has(key)) memo.delete(key);
}

/**
 * The memoised result for a row, without computing: `{ board }` (board may be undefined = not dealable) when `id:version` was seen
 * at this rank, else undefined (a miss: the caller fetches `data` and calls `rowToGridBoard`).
 */
export function peekGridBoard(id: string, version: number, rank: Rank): { board: GridWireBoard | undefined } | undefined {
  const hit = memo.get(`${id}:${version}`);
  return hit && hit.rank === rank ? { board: hit.board } : undefined;
}

/** Drops the memo entries of `rank` whose `id:version` key is not in `keep` (other ranks' entries stay). */
export function pruneGridBoardMemoAtRank(rank: Rank, keep: ReadonlySet<string>): void {
  for (const [key, entry] of [...memo.entries()]) if (entry.rank === rank && !keep.has(key)) memo.delete(key);
}

/** Test hook: the number of memoised entries. */
export function gridBoardMemoSize(): number {
  return memo.size;
}
