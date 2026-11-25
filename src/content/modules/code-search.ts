import type { ContentModuleMapping, ImportIssue, ParsedRow, ParsedSheet, PayloadCheck, StoredItem } from "../content-module.js";
import { SpreadsheetError } from "../xlsx.js";
import type { Cell, SheetRow } from "../xlsx.js";
import { CODE_SEARCH_ID, checkBoardFit, checkBoardPayload } from "../grid-boards.js";
import { isRank } from "../../rules/ranks.js";
import type { Rank } from "../../rules/ranks.js";
import { rankDisplayName, rankFromDisplayName } from "../../rules/catalog.js";

/**
 * Code Search (module `code-search`): one board per row, from the client's master pack as a sheet (see
 * docs/plans/code-search.md section 2 and G). The client sheet is `Game ID | Level | Letters | Targets`; Targets is the
 * JSON array of the pack's targets in one cell. An admin export is `Id | Version | Level | Letters | Targets | Status`.
 *
 * IDS COME FROM THE SHEET (`keyIsId`): the pack's id (`CS-TR-0001`), whose prefix must match the Level. The payload is
 * `{ letters, targets }`; every rule is `src/content/grid-boards.ts` (rank-free rules in `validatePayload`, rank-fit
 * rules in `validateItem` and as row errors). Nothing is normalised: a non-canonical board is refused.
 */

const REQUIRED_HEADERS = ["level", "letters", "targets"] as const;
const HEADER_SCAN_ROWS = 10;
const TARGET_KEY_ORDER = ["airportId", "code", "clue", "city", "row", "column", "direction"] as const;

export const CODE_SEARCH_CLIENT_HEADER = ["Game ID", "Level", "Letters", "Targets"] as const;
export const CODE_SEARCH_EXPORT_HEADER = ["Id", "Version", "Level", "Letters", "Targets", "Status"] as const;

function text(cell: Cell | undefined): string {
  if (cell === null || cell === undefined) return "";
  if (cell instanceof Date) return cell.toISOString();
  return String(cell).trim();
}

function normalise(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function findHeader(rows: SheetRow[]): { rowIndex: number; columns: Map<string, number>; admin: boolean } {
  for (let rowIndex = 0; rowIndex < Math.min(rows.length, HEADER_SCAN_ROWS); rowIndex++) {
    const columns = new Map<string, number>();
    (rows[rowIndex] ?? []).forEach((cell, column) => {
      const name = normalise(text(cell));
      if (name && !columns.has(name)) columns.set(name, column);
    });
    if (!REQUIRED_HEADERS.every((name) => columns.has(name))) continue;
    if (columns.has("id")) return { rowIndex, columns, admin: true };
    if (columns.has("game id")) return { rowIndex, columns, admin: false };
  }
  throw new SpreadsheetError("Could not find the header row (Game ID, Level, Letters, Targets) in the first 10 rows.");
}

function parseVersion(raw: Cell | undefined): number | undefined | "invalid" {
  const value = text(raw);
  if (value === "") return undefined;
  if (!/^[1-9]\d{0,8}$/.test(value)) return "invalid";
  return Number(value);
}

function unique(problems: string[]): string[] {
  return [...new Set(problems)];
}

function parse(rows: SheetRow[]): ParsedSheet {
  const { rowIndex: headerIndex, columns, admin } = findHeader(rows);
  const cell = (row: SheetRow, name: string): string => text(row[columns.get(name) ?? -1]);
  const idColumn = admin ? "id" : "game id";
  const parsed: ParsedRow[] = [];
  const issues: ImportIssue[] = [];

  for (let index = headerIndex + 1; index < rows.length; index++) {
    const row = rows[index] ?? [];
    const sheetRow = index + 1;
    const id = cell(row, idColumn);
    const level = cell(row, "level");
    const letters = cell(row, "letters");
    const targetsText = cell(row, "targets");
    if (id === "" && level === "" && letters === "" && targetsText === "") continue; // a blank row

    const problems: string[] = [];
    const rank = rankFromDisplayName(level);
    if (!rank) problems.push(level === "" ? "Level is missing." : "Level is not one of Trainee, First Officer, Captain, Check Airman, Chief Pilot.");
    if (id === "") problems.push(`${admin ? "Id" : "Game ID"} is missing.`);
    else if (!CODE_SEARCH_ID.test(id)) problems.push("Id must look like CS-TR-0001 (TR, FO, CA, CH or CP, then four digits).");

    let targets: unknown;
    let jsonOk = false;
    if (targetsText === "") problems.push("Targets is missing.");
    else {
      try {
        targets = JSON.parse(targetsText);
        jsonOk = true;
      } catch {
        problems.push("Targets is not valid JSON (expected a list of targets).");
      }
    }

    let version: number | undefined;
    if (admin && columns.has("version")) {
      const result = parseVersion(row[columns.get("version") ?? -1]);
      if (result === "invalid") problems.push("Version must be a whole number of 1 or more.");
      else version = result;
    }

    const data = { letters, targets } as Record<string, unknown>;
    if (jsonOk) {
      const payload = checkBoardPayload(data);
      const fit = rank && id !== "" ? checkBoardFit(id, rank, data) : [];
      problems.push(...payload, ...fit);
    }

    if (problems.length > 0 || !rank) {
      issues.push({ row: sheetRow, ...(id ? { id } : {}), level: "error", message: unique(problems).join(" ") });
      continue;
    }
    parsed.push({ row: sheetRow, id: admin ? id : undefined, naturalKey: id, version, rank, data });
  }
  return { kind: admin ? "admin_export" : "client_sheet", rows: parsed, issues };
}

/** The rank-free rules (`checkBoardPayload`); the payload is returned as given (nothing is normalised). */
function validatePayload(input: unknown): PayloadCheck {
  const problems = checkBoardPayload(input);
  const data = input !== null && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  return { data, problems };
}

/** The target codes joined by a space (display only: the planner matches boards by id). */
function naturalKey(data: unknown): string {
  const targets = (data as { targets?: unknown } | null)?.targets;
  if (!Array.isArray(targets)) return "";
  return targets.map((t) => String((t as { code?: unknown } | null)?.code ?? "")).join(" ");
}

/** Targets as JSON with the keys in the pack's order (jsonb returns them in its own order). */
export function targetsCell(targets: unknown): string {
  if (!Array.isArray(targets)) return JSON.stringify(targets ?? []);
  return JSON.stringify(
    targets.map((t) => {
      if (t === null || typeof t !== "object" || Array.isArray(t)) return t;
      const record = t as Record<string, unknown>;
      const ordered: Record<string, unknown> = {};
      for (const key of TARGET_KEY_ORDER) if (Object.hasOwn(record, key)) ordered[key] = record[key];
      for (const key of Object.keys(record)) if (!Object.hasOwn(ordered, key)) ordered[key] = record[key];
      return ordered;
    }),
  );
}

function exportRows(items: readonly StoredItem[]): (string | number)[][] {
  const out: (string | number)[][] = [[...CODE_SEARCH_EXPORT_HEADER]];
  for (const item of items) {
    const data = (item.data ?? {}) as { letters?: unknown; targets?: unknown };
    out.push([
      item.id,
      item.version,
      isRank(item.rank) ? rankDisplayName(item.rank) : item.rank,
      typeof data.letters === "string" ? data.letters : "",
      targetsCell(data.targets),
      item.status,
    ]);
  }
  return out;
}

export const codeSearchMapping: ContentModuleMapping = {
  module: "code-search",
  parse,
  validatePayload,
  validateItem: (id: string, rank: Rank, data: unknown) => checkBoardFit(id, rank, data),
  keyIsId: true,
  naturalKey,
  // No sequence: every id comes from the sheet.
  formatId: () => undefined,
  idNumber: (id) => (CODE_SEARCH_ID.test(id) ? Number(id.slice(-4)) : undefined),
  exportRows,
};
