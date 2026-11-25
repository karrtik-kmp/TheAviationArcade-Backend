/**
 * Code Search word grid rules: an exact port of Unity `Assets/_Project/Scripts/Gameplay/CodeSearch/`
 * `GridDirection.cs`, `GridCell.cs`, `WordGridPuzzle.cs`, `WordGridTarget.cs` and `WordGridPuzzleValidator.cs`.
 * Change both together; keep test names aligned with `WordGridPuzzleValidatorTests`.
 *
 * `validatePuzzle` returns the SAME messages in the SAME order as C# `Validate`. Pure: no clock, no I/O.
 * Text rules work on UTF-16 units as C# `char` does (upper-casing is per unit and simple, never length-changing).
 */

/** The eight reading directions, in Unity enum order (the index is the delta table index). */
export const GRID_DIRECTIONS = ["East", "SouthEast", "South", "SouthWest", "West", "NorthWest", "North", "NorthEast"] as const;
export type GridDirection = (typeof GRID_DIRECTIONS)[number];

const ROW_DELTAS = [0, 1, 1, 1, 0, -1, -1, -1] as const;
const COLUMN_DELTAS = [1, 1, 0, -1, -1, -1, 0, 1] as const;

export function isGridDirection(value: unknown): value is GridDirection {
  return typeof value === "string" && (GRID_DIRECTIONS as readonly string[]).includes(value);
}

/** One letter position. Row 0 is the top row, column 0 the left column. */
export type GridCell = { readonly row: number; readonly column: number };

export function cell(row: number, column: number): GridCell {
  return { row, column };
}

/** `GridCell.ToString`. */
export function cellText(c: GridCell): string {
  return `(${c.row},${c.column})`;
}

export function sameCell(a: GridCell, b: GridCell): boolean {
  return a.row === b.row && a.column === b.column;
}

export function deltaRow(direction: GridDirection): number {
  return ROW_DELTAS[GRID_DIRECTIONS.indexOf(direction)] as number;
}

export function deltaColumn(direction: GridDirection): number {
  return COLUMN_DELTAS[GRID_DIRECTIONS.indexOf(direction)] as number;
}

/** `GridCell.Step`. */
export function step(from: GridCell, direction: GridDirection, distance = 1): GridCell {
  return { row: from.row + deltaRow(direction) * distance, column: from.column + deltaColumn(direction) * distance };
}

function isInside(c: GridCell, width: number, height: number): boolean {
  return c.row >= 0 && c.row < height && c.column >= 0 && c.column < width;
}

/**
 * `GridDirections.TryResolve`: the direction and cell count (both ends included) of the straight line from
 * `start` to `end`; undefined when the cells are the same or share no row, column or 45-degree diagonal.
 */
export function tryResolve(start: GridCell, end: GridCell): { direction: GridDirection; length: number } | undefined {
  const dRow = end.row - start.row;
  const dColumn = end.column - start.column;
  if (dRow === 0 && dColumn === 0) return undefined;
  if (dRow !== 0 && dColumn !== 0 && Math.abs(dRow) !== Math.abs(dColumn)) return undefined;
  const stepRow = Math.sign(dRow);
  const stepColumn = Math.sign(dColumn);
  for (let i = 0; i < GRID_DIRECTIONS.length; i++) {
    if (ROW_DELTAS[i] !== stepRow || COLUMN_DELTAS[i] !== stepColumn) continue;
    return { direction: GRID_DIRECTIONS[i] as GridDirection, length: Math.max(Math.abs(dRow), Math.abs(dColumn)) + 1 };
  }
  return undefined;
}

/** `GridDirections.Line`: the cells from start to end, or undefined when it is not a straight line. */
export function line(start: GridCell, end: GridCell): GridCell[] | undefined {
  const resolved = tryResolve(start, end);
  if (!resolved) return undefined;
  const cells: GridCell[] = [];
  for (let i = 0; i < resolved.length; i++) cells.push(step(start, resolved.direction, i));
  return cells;
}

// ---- text ----

/** Simple per-unit upper-casing, like C# `char.ToUpperInvariant`: a unit whose upper case is not one unit stays. */
function upperUnit(unit: string): string {
  const upper = unit.toUpperCase();
  return upper.length === 1 ? upper : unit;
}

/** `string.ToUpperInvariant()` over UTF-16 units. */
export function upperInvariant(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) out += upperUnit(text[i] as string);
  return out;
}

/** True for a string that `makeTarget` / `makePuzzle` would leave as it is (canonical stored form). */
export function isCanonicalCode(code: string): boolean {
  return code === upperInvariant(code.trim());
}

/** `StringComparer.OrdinalIgnoreCase` as a key: compares per UTF-16 unit, upper-cased. */
function ignoreCaseKey(text: string): string {
  return upperInvariant(text);
}

// ---- puzzle ----

export type WordGridTarget = {
  readonly airportId: string;
  /** Trimmed and upper-cased. */
  readonly code: string;
  /** Trimmed. */
  readonly clue: string;
  /** The cells in the order the code reads, so `path[0]` is the hint cell whichever way it runs. */
  readonly path: readonly GridCell[];
};

/** `new WordGridTarget(airportId, code, clue, path)`: normalises as the C# constructor does. */
export function makeTarget(
  airportId: string | null | undefined,
  code: string | null | undefined,
  clue: string | null | undefined,
  path: readonly GridCell[],
): WordGridTarget {
  if (!path) throw new Error("path is required.");
  return {
    airportId: airportId ?? "",
    code: upperInvariant((code ?? "").trim()),
    clue: (clue ?? "").trim(),
    path: path.map((c) => ({ row: c.row, column: c.column })),
  };
}

export type WordGridPuzzle = {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  /** Row-major, upper case. */
  readonly letters: string;
  readonly targets: readonly WordGridTarget[];
};

/**
 * `new WordGridPuzzle(id, width, height, letters, targets)`: checks shape only (the validator owns the rules) and
 * upper-cases the letters. Throws on a blank id, a side below 1, a letter count other than width x height, or no targets list.
 */
export function makePuzzle(
  id: string | null | undefined,
  width: number,
  height: number,
  letters: string | null | undefined,
  targets: readonly WordGridTarget[] | null | undefined,
): WordGridPuzzle {
  if (id === null || id === undefined || id.trim() === "") throw new Error("Puzzle id required.");
  if (!(width >= 1)) throw new RangeError("width");
  if (!(height >= 1)) throw new RangeError("height");
  if (letters === null || letters === undefined || letters.length !== width * height) {
    throw new Error("A grid needs exactly width x height letters.");
  }
  if (!targets) throw new TypeError("targets");
  for (const target of targets) if (!target) throw new Error("A target is null.");
  return { id, width, height, letters: upperInvariant(letters), targets: [...targets] };
}

function contains(puzzle: WordGridPuzzle, c: GridCell): boolean {
  return isInside(c, puzzle.width, puzzle.height);
}

function letterAt(puzzle: WordGridPuzzle, c: GridCell): string {
  if (!contains(puzzle, c)) throw new RangeError("cell");
  return puzzle.letters[c.row * puzzle.width + c.column] as string;
}

/** `WordGridPuzzle.Read`: the letters along a straight line, or undefined when it is bent or leaves the grid. */
export function read(puzzle: WordGridPuzzle, start: GridCell, end: GridCell): string | undefined {
  const cells = line(start, end);
  if (!cells || !contains(puzzle, start) || !contains(puzzle, end)) return undefined;
  return cells.map((c) => letterAt(puzzle, c)).join("");
}

function before(a: GridCell, b: GridCell): boolean {
  return a.row < b.row || (a.row === b.row && a.column <= b.column);
}

/**
 * `WordGridPuzzle.FindOccurrences`: every straight placement of `word` in the grid, in any of the eight directions.
 * A placement and its mirror (the same cells read backwards) count once, so a palindrome is one hit.
 */
export function findOccurrences(puzzle: WordGridPuzzle, word: string): GridCell[][] {
  const { letters, width, height } = puzzle;
  const hits: GridCell[][] = [];
  if (word.length === 0) return hits;
  const seen = new Set<string>();
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const start = { row, column };
      if (letters[row * width + column] !== word[0]) continue;
      for (const direction of GRID_DIRECTIONS) {
        if (word.length === 1 && direction !== "East") break;
        const end = step(start, direction, word.length - 1);
        if (!isInside(end, width, height)) continue;

        const path: GridCell[] = [];
        let spelled = true;
        for (let i = 0; i < word.length && spelled; i++) {
          const c = step(start, direction, i);
          path.push(c);
          spelled = letters[c.row * width + c.column] === word[i];
        }
        if (!spelled) continue;
        const [a, b] = before(start, end) ? [start, end] : [end, start];
        const key = `${a.row},${a.column},${b.row},${b.column}`;
        if (!seen.has(key)) {
          seen.add(key);
          hits.push(path);
        }
      }
    }
  }
  return hits;
}

// ---- validator ----

export const MIN_CODE_LENGTH = 2;

function isLetterCode(code: string): boolean {
  if (code.length < MIN_CODE_LENGTH) return false;
  for (let i = 0; i < code.length; i++) {
    const letter = code[i] as string;
    if (letter < "A" || letter > "Z") return false;
  }
  return true;
}

function reverse(text: string): string {
  let out = "";
  for (let i = text.length - 1; i >= 0; i--) out += text[i];
  return out;
}

function validatePath(
  puzzle: WordGridPuzzle,
  target: WordGridTarget,
  name: string,
  allowed: readonly GridDirection[] | undefined,
  errors: string[],
): boolean {
  const path = target.path;
  if (path.length !== target.code.length || path.length < MIN_CODE_LENGTH) {
    errors.push(`${name} path has ${path.length} cells for a ${target.code.length}-letter code.`);
    return false;
  }
  for (const c of path) {
    if (contains(puzzle, c)) continue;
    errors.push(`${name} path leaves the ${puzzle.width}x${puzzle.height} grid at ${cellText(c)}.`);
    return false;
  }
  const first = tryResolve(path[0] as GridCell, path[1] as GridCell);
  if (!first || first.length !== 2) {
    errors.push(`${name} path is not contiguous.`);
    return false;
  }
  const direction = first.direction;
  for (let i = 2; i < path.length; i++) {
    if (sameCell(path[i] as GridCell, step(path[i - 1] as GridCell, direction))) continue;
    errors.push(`${name} path is not one straight contiguous line.`);
    return false;
  }
  if (allowed !== undefined && !allowed.includes(direction)) {
    errors.push(`${name} runs ${direction}, which this puzzle does not allow.`);
    return false;
  }
  for (let i = 0; i < path.length; i++) {
    if (letterAt(puzzle, path[i] as GridCell) === target.code[i]) continue;
    errors.push(`${name} path does not spell its code.`);
    return false;
  }
  return true;
}

/**
 * `WordGridPuzzleValidator.Validate`: every problem, not the first, in Unity's order and wording.
 * `allowedDirections` undefined allows all eight.
 */
export function validatePuzzle(puzzle: WordGridPuzzle | null | undefined, allowedDirections?: readonly GridDirection[]): string[] {
  const errors: string[] = [];
  if (!puzzle) {
    errors.push("Puzzle is null.");
    return errors;
  }

  for (let i = 0; i < puzzle.letters.length; i++) {
    const letter = puzzle.letters[i] as string;
    if (letter < "A" || letter > "Z") {
      errors.push(`Cell ${i} holds '${letter}', not a letter A-Z.`);
      break;
    }
  }

  if (puzzle.targets.length === 0) errors.push("A puzzle needs at least one target.");

  const airportIds = new Set<string>();
  const codes = new Set<string>();
  const reversedCodes = new Set<string>();
  const clues = new Set<string>();
  for (let t = 0; t < puzzle.targets.length; t++) {
    const target = puzzle.targets[t] as WordGridTarget;
    const name = `Target ${t} (${target.code})`;

    if (target.airportId.trim() === "") errors.push(`${name} has no airport id.`);
    else if (airportIds.has(target.airportId)) errors.push(`${name} repeats airport '${target.airportId}'.`);
    else airportIds.add(target.airportId);

    // City clues must tell apart two airports that share a city, so a repeated clue is ambiguous.
    if (target.clue.length === 0) errors.push(`${name} has no clue.`);
    else {
      const key = ignoreCaseKey(target.clue);
      if (clues.has(key)) errors.push(`${name} repeats the clue '${target.clue}'.`);
      else clues.add(key);
    }

    const codeIsLetters = isLetterCode(target.code);
    if (!codeIsLetters) {
      errors.push(`${name} needs a code of at least ${MIN_CODE_LENGTH} letters A-Z.`);
    } else {
      // A code and its reverse sit on the same cells, so one selection would find both.
      if (codes.has(target.code)) errors.push(`${name} repeats code '${target.code}'.`);
      else {
        codes.add(target.code);
        if (reversedCodes.has(target.code)) errors.push(`${name} is the reverse of another target's code.`);
      }
      reversedCodes.add(reverse(target.code));
    }

    const pathOk = validatePath(puzzle, target, name, allowedDirections, errors);

    const first = target.path[0];
    if (!first || !contains(puzzle, first) || target.code.length === 0 || letterAt(puzzle, first) !== target.code[0]) {
      errors.push(`${name} has no resolvable first-letter hint cell.`);
    }

    if (codeIsLetters && pathOk) {
      const occurrences = findOccurrences(puzzle, target.code);
      if (occurrences.length > 1) errors.push(`${name} appears ${occurrences.length} times in the grid; it must appear once.`);
    }
  }
  return errors;
}

export function isValidPuzzle(puzzle: WordGridPuzzle | null | undefined): boolean {
  return validatePuzzle(puzzle).length === 0;
}

/** `EnsureValid`: throws naming every problem. */
export function ensureValidPuzzle(puzzle: WordGridPuzzle | null | undefined, allowedDirections?: readonly GridDirection[]): void {
  const errors = validatePuzzle(puzzle, allowedDirections);
  if (errors.length > 0) throw new Error(`Puzzle '${puzzle?.id}' is invalid: ${errors.join("; ")}`);
}
