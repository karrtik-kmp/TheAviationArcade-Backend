import type { ContentModuleMapping, ImportIssue, ParsedRow, ParsedSheet, StoredItem } from "../content-module.js";
import { SpreadsheetError } from "../xlsx.js";
import type { Cell, SheetRow } from "../xlsx.js";
import { isRank } from "../../rules/ranks.js";
import { rankDisplayName, rankFromDisplayName } from "../../rules/catalog.js";

/**
 * Military Aircraft Identifier (working title) from the client's sheet "Military Airplane Identifier v1.xlsx":
 * header on sheet row 3 (found by scanning the first rows), then one question per row. Ids are the Unity
 * ids mil-a1, mil-a2, ... in sheet order. Values are stored as written except for trimming surrounding
 * whitespace; typos in file names are kept and only reported as warnings.
 */

export const MILITARY_ID = /^mil-a[1-9]\d{0,5}$/;

const REQUIRED_HEADERS = ["level", "correct answer", "wrong answer 1", "wrong answer 2", "wrong answer 3", "file", "photographer"] as const;
const HEADER_SCAN_ROWS = 10;
const IMAGE_FILE = /\.(jpe?g|png)$/i;

export const MILITARY_EXPORT_HEADER = [
  "Id",
  "Version",
  "Level",
  "Correct Answer",
  "Wrong Answer 1",
  "Wrong Answer 2",
  "Wrong Answer 3",
  "file",
  "Photographer",
  "Status",
] as const;

/** Cell to trimmed text. Numbers and booleans are kept as written; blanks are "". */
function text(cell: Cell | undefined): string {
  if (cell === null || cell === undefined) return "";
  if (cell instanceof Date) return cell.toISOString();
  return String(cell).trim();
}

function normalise(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Column index per header name, from the first of the leading rows that has every required header. */
function findHeader(rows: SheetRow[]): { rowIndex: number; columns: Map<string, number> } {
  for (let rowIndex = 0; rowIndex < Math.min(rows.length, HEADER_SCAN_ROWS); rowIndex++) {
    const columns = new Map<string, number>();
    (rows[rowIndex] ?? []).forEach((cell, column) => {
      const name = normalise(text(cell));
      if (name && !columns.has(name)) columns.set(name, column);
    });
    if (REQUIRED_HEADERS.every((name) => columns.has(name))) return { rowIndex, columns };
  }
  throw new SpreadsheetError(
    "Could not find the header row (Level, Correct Answer, Wrong Answer 1-3, file, Photographer) in the first 10 rows.",
  );
}

function parseVersion(raw: Cell | undefined): number | undefined | "invalid" {
  const value = text(raw);
  if (value === "") return undefined;
  if (!/^[1-9]\d{0,8}$/.test(value)) return "invalid";
  return Number(value);
}

function parse(rows: SheetRow[]): ParsedSheet {
  const { rowIndex: headerIndex, columns } = findHeader(rows);
  const cell = (row: SheetRow, name: string): string => text(row[columns.get(name) ?? -1]);
  const hasIdColumn = columns.has("id");
  const hasVersionColumn = columns.has("version");
  const parsed: ParsedRow[] = [];
  const issues: ImportIssue[] = [];
  // Without an Id column this is a client sheet: ids are the planner's job (matched by `file`, else the next
  // free mil-aN). Placeholder rows (only a Level) are skipped and never take an id.
  // A Status column, if present, is never read: it is informational in our export.

  for (let index = headerIndex + 1; index < rows.length; index++) {
    const row = rows[index] ?? [];
    const sheetRow = index + 1;
    const level = cell(row, "level");
    const answer = cell(row, "correct answer");
    const wrong = [cell(row, "wrong answer 1"), cell(row, "wrong answer 2"), cell(row, "wrong answer 3")];
    const sourceFile = cell(row, "file");
    const photographer = cell(row, "photographer");
    const explicitId = hasIdColumn ? cell(row, "id") : "";

    const hasContent = answer !== "" || wrong.some((value) => value !== "") || sourceFile !== "" || photographer !== "";
    if (!hasContent) {
      // Entirely blank rows are ignored; a row with only a Level (or Id) is a placeholder worth mentioning.
      if (level !== "" || explicitId !== "") {
        issues.push({
          row: sheetRow,
          ...(explicitId ? { id: explicitId } : {}),
          level: "warning",
          message: "Placeholder row (no answers) skipped.",
        });
      }
      continue;
    }

    const problems: string[] = [];
    const rank = rankFromDisplayName(level);
    if (!rank) problems.push(level === "" ? "Level is missing." : "Level is not one of Trainee, First Officer, Captain, Check Airman, Chief Pilot.");
    if (answer === "") problems.push("Correct Answer is missing.");
    wrong.forEach((value, i) => {
      if (value === "") problems.push(`Wrong Answer ${i + 1} is missing.`);
    });
    if (answer !== "" && wrong.every((value) => value !== "")) {
      const options = [answer, ...wrong].map(normalise);
      if (new Set(options).size !== options.length) problems.push("The correct and wrong answers must all be different.");
    }

    let id: string | undefined;
    if (hasIdColumn) {
      id = explicitId;
      if (id === "") problems.push("Id is required when the sheet has an Id column.");
      else if (!MILITARY_ID.test(id)) problems.push("Id must look like mil-a12.");
    }

    let version: number | undefined;
    if (hasVersionColumn) {
      const result = parseVersion(row[columns.get("version") ?? -1]);
      if (result === "invalid") problems.push("Version must be a whole number of 1 or more.");
      else version = result;
    }

    if (problems.length > 0 || !rank) {
      issues.push({ row: sheetRow, ...(id ? { id } : {}), level: "error", message: problems.join(" ") });
      continue;
    }

    if (!IMAGE_FILE.test(sourceFile)) {
      issues.push({
        row: sheetRow,
        ...(id ? { id } : {}),
        level: "warning",
        message: sourceFile === "" ? "File name is empty." : "File name has no .jpg/.jpeg/.png extension.",
      });
    }
    if (photographer === "") issues.push({ row: sheetRow, ...(id ? { id } : {}), level: "warning", message: "Photographer is missing." });

    parsed.push({ row: sheetRow, id, naturalKey: sourceFile.normalize("NFC"), version, rank, data: { answer, wrong, sourceFile, photographer } });
  }
  return { kind: hasIdColumn ? "admin_export" : "client_sheet", rows: parsed, issues };
}

function exportRows(items: readonly StoredItem[]): (string | number)[][] {
  const out: (string | number)[][] = [[...MILITARY_EXPORT_HEADER]];
  for (const item of items) {
    const data = item.data as { answer: string; wrong: string[]; sourceFile: string; photographer: string };
    out.push([
      item.id,
      item.version,
      isRank(item.rank) ? rankDisplayName(item.rank) : item.rank,
      data.answer,
      data.wrong[0] ?? "",
      data.wrong[1] ?? "",
      data.wrong[2] ?? "",
      data.sourceFile,
      data.photographer,
      item.status,
    ]);
  }
  return out;
}

export const militaryMapping: ContentModuleMapping = {
  module: "aircraft-identifier-military",
  parse,
  naturalKey: (data) => String((data as { sourceFile?: unknown } | null)?.sourceFile ?? "").trim().normalize("NFC"),
  formatId: (n) => {
    const id = `mil-a${n}`;
    return Number.isSafeInteger(n) && MILITARY_ID.test(id) ? id : undefined;
  },
  idNumber: (id) => (MILITARY_ID.test(id) ? Number(id.slice("mil-a".length)) : undefined),
  exportRows,
};
