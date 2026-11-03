import type { ContentModuleMapping, ImportIssue, PayloadCheck, ParsedRow, ParsedSheet, StoredItem } from "../content-module.js";
import { SpreadsheetError } from "../xlsx.js";
import type { Cell, SheetRow } from "../xlsx.js";
import { isRank } from "../../rules/ranks.js";
import { rankDisplayName, rankFromDisplayName } from "../../rules/catalog.js";

/**
 * Airport Spotter from the client's sheet "Airport Spotter v1.xlsx": header on sheet row 3 (found by scanning
 * the first rows), then one photo question per row. The correct answer and the three wrong answers are 3-letter
 * IATA airport codes. The sheet has no photographer column (only an "Image" column of embedded pictures, which
 * is not read), so the payload is `{ answer, wrong[3], sourceFile }`, the same shape the Trip dealer reads for
 * Military. Airport display names are NOT stored: they come from Unity's pinned OurAirports snapshot, which is
 * not client content.
 *
 * Ids are `apt-a<N>` in sheet order (the planner assigns them). Unity's own ids (`airport-apt-<iata>-<n>`) are a
 * function of the photo file name, `api_<iata>_10_22_26_<n>.jpg` -> `apt-<iata>-<n>`, so they are not
 * sequential and cannot be the backend id; the file name (the natural key) is the join between the two.
 *
 * CORRECTIONS (user ruling 2026-11-03): the seven fixes Unity's import_airport_spotter.py applies are applied
 * here too, from the named table below. A correction fires only while its row still holds the original value
 * (row, correct airport and original text all match); once the client fixes a row, nothing fires. Each applied
 * correction is reported as a warning. Anything not in the table is validated as written and is an error.
 */

export const AIRPORT_SPOTTER_ID = /^apt-a[1-9]\d{0,5}$/;

const REQUIRED_HEADERS = ["level", "correct airport", "wrong airport 1", "wrong airport 2", "wrong airport 3", "file name"] as const;
const HEADER_SCAN_ROWS = 10;
const IMAGE_FILE = /\.(jpe?g|png)$/i;
const IATA = /^[A-Z]{3}$/;

export const AIRPORT_SPOTTER_EXPORT_HEADER = [
  "Id",
  "Version",
  "LEVEL",
  "Correct Airport",
  "Wrong Airport 1",
  "Wrong Airport 2",
  "Wrong Airport 3",
  "File name",
  "Status",
] as const;

/** Where in a row a correction applies: the photo file name, or the wrong airport at index 0..2. */
export type CorrectionField = "file" | 0 | 1 | 2;

export type AirportCorrection = {
  /** 1-based sheet row of the client's v1 sheet. */
  row: number;
  /** The row's correct airport; must still match, so a re-ordered sheet never triggers a fix on another row. */
  answer: string;
  field: CorrectionField;
  /** The value the sheet held when Unity's importer fixed it. The correction applies only while the cell still holds exactly this. */
  from: string;
  to: string;
  /** A wrong-answer index that must hold the same `from` value too (the "listed twice" case). */
  alsoAt?: 0 | 1 | 2;
  reason: string;
};

/**
 * The corrections, copied from Unity's import_airport_spotter.py (FILENAME_FIXES, CODE_FIXES, the extension/case
 * matching and the duplicate-code fix) as documented in Unity CLIENT_CONTENT_IMPORT.md "Airport Spotter".
 * The photo file names point at photos in Unity's delivery folder, which the backend does not hold.
 */
export const AIRPORT_SPOTTER_CORRECTIONS: readonly AirportCorrection[] = [
  { row: 9, answer: "DCA", field: "file", from: "api_lax_10_22_26_6.jpg", to: "api_dca_10_22_26_1.jpg", reason: "the named photo is not in the delivery; pointed at the unused api_dca_10_22_26_1.jpg" },
  { row: 17, answer: "LAX", field: "file", from: "api_lax_10_22_26_14", to: "api_lax_10_22_26_14.jpg", reason: "the file name has no extension" },
  { row: 21, answer: "LAX", field: 1, from: "LAS", to: "BOS", alsoAt: 0, reason: "LAS is listed twice; the duplicate became BOS (Unity drew it deterministically from the sheet's own codes; BOS is Unity's choice, not the client's)" },
  { row: 24, answer: "DCA", field: "file", from: "api_dca_10_22_26_2", to: "api_dca_10_22_26_2.jpg", reason: "the file name has no extension" },
  { row: 32, answer: "DCA", field: "file", from: "api_dca_10_22_26_3.JPG", to: "api_dca_10_22_26_3.jpg", reason: "the extension differs in case from the photo delivered" },
  { row: 40, answer: "DFW", field: "file", from: "api_dfw_10_22_26_1.jpg", to: "api_dfw_10_22_26_2.jpg", reason: "the file is already row 39's; pointed at the unused api_dfw_10_22_26_2.jpg" },
  { row: 44, answer: "FRA", field: 0, from: "MUN", to: "MUC", reason: "MUN is Maturin, Venezuela; read as Munich MUC (row 47 uses MUC)" },
];

/** Cell to trimmed text. Numbers and booleans are kept as written; blanks are "". */
function text(cell: Cell | undefined): string {
  if (cell === null || cell === undefined) return "";
  if (cell instanceof Date) return cell.toISOString();
  return String(cell).trim();
}

function normalise(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

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
    "Could not find the header row (LEVEL, Correct Airport, Wrong Airport 1-3, File name) in the first 10 rows.",
  );
}

function parseVersion(raw: Cell | undefined): number | undefined | "invalid" {
  const value = text(raw);
  if (value === "") return undefined;
  if (!/^[1-9]\d{0,8}$/.test(value)) return "invalid";
  return Number(value);
}

const PAYLOAD_KEYS = ["answer", "wrong", "sourceFile"] as const;

/**
 * The Airport Spotter payload rules, shared by the sheet parser and the staff edit endpoint: `{ answer,
 * wrong[3], sourceFile }`, all strings, no other keys. Each airport code is trimmed and upper-cased (as Unity's
 * importer does) and must then be exactly three letters A-Z; the four codes must be distinct. `sourceFile` (the
 * natural key) may be blank here: an import only warns, and the planner enforces a unique non-blank one.
 */
function validatePayload(input: unknown): PayloadCheck {
  const problems: string[] = [];
  const empty = { answer: "", wrong: ["", "", ""], sourceFile: "" };
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { data: empty, problems: ["The payload must be an object { answer, wrong, sourceFile }."] };
  }
  const record = input as Record<string, unknown>;
  const extra = Object.keys(record).filter((key) => !(PAYLOAD_KEYS as readonly string[]).includes(key));
  if (extra.length > 0) problems.push(`Unknown field(s): ${extra.slice(0, 5).join(", ")}.`);
  const str = (value: unknown, label: string): string => {
    if (typeof value === "string") return value.trim();
    problems.push(`${label} must be text.`);
    return "";
  };
  const code = (value: unknown, label: string): string => {
    const upper = str(value, label).toUpperCase();
    if (upper === "") problems.push(`${label} is missing.`);
    else if (!IATA.test(upper)) problems.push(`${label} must be a 3-letter airport code (got "${upper.slice(0, 20)}").`);
    return upper;
  };
  const answer = code(record["answer"], "Correct Airport");
  const sourceFile = str(record["sourceFile"], "File name");
  let wrong: string[] = ["", "", ""];
  if (Array.isArray(record["wrong"]) && record["wrong"].length === 3) {
    wrong = record["wrong"].map((value, i) => code(value, `Wrong Airport ${i + 1}`));
  } else {
    problems.push("wrong must be exactly three airport codes.");
  }
  const options = [answer, ...wrong];
  if (options.every((value) => IATA.test(value)) && new Set(options).size !== options.length) {
    problems.push("The correct and wrong airports must all be different.");
  }
  return { data: { answer, wrong, sourceFile }, problems };
}

type RawRow = { file: string; answer: string; wrong: string[] };

/** Apply the table to one row's raw text. Returns the corrected row and a warning per fix that fired. */
function applyCorrections(sheetRow: number, raw: RawRow): { row: RawRow; warnings: string[] } {
  const row: RawRow = { file: raw.file, answer: raw.answer, wrong: [...raw.wrong] };
  const warnings: string[] = [];
  for (const fix of AIRPORT_SPOTTER_CORRECTIONS) {
    if (fix.row !== sheetRow || raw.answer.toUpperCase() !== fix.answer) continue;
    const original = fix.field === "file" ? raw.file : (raw.wrong[fix.field] ?? "");
    if (original !== fix.from) continue;
    if (fix.alsoAt !== undefined && (raw.wrong[fix.alsoAt] ?? "") !== fix.from) continue;
    if (fix.field === "file") row.file = fix.to;
    else row.wrong[fix.field] = fix.to;
    const where = fix.field === "file" ? "File name" : `Wrong Airport ${fix.field + 1}`;
    warnings.push(`Corrected on import: ${where} "${fix.from}" -> "${fix.to}" (${fix.reason}). Client to confirm.`);
  }
  return { row, warnings };
}

function parse(rows: SheetRow[]): ParsedSheet {
  const { rowIndex: headerIndex, columns } = findHeader(rows);
  const cell = (row: SheetRow, name: string): string => text(row[columns.get(name) ?? -1]);
  const hasIdColumn = columns.has("id");
  const hasVersionColumn = columns.has("version");
  const parsed: ParsedRow[] = [];
  const issues: ImportIssue[] = [];
  // Without an Id column this is a client sheet and the corrections table applies. An admin export (our own
  // file, with ids) is never "corrected": it is taken as written. A Status column is never read.

  for (let index = headerIndex + 1; index < rows.length; index++) {
    const row = rows[index] ?? [];
    const sheetRow = index + 1;
    const level = cell(row, "level");
    const rawRow: RawRow = {
      answer: cell(row, "correct airport"),
      wrong: [cell(row, "wrong airport 1"), cell(row, "wrong airport 2"), cell(row, "wrong airport 3")],
      file: cell(row, "file name"),
    };
    const explicitId = hasIdColumn ? cell(row, "id") : "";

    const hasContent = rawRow.answer !== "" || rawRow.wrong.some((value) => value !== "") || rawRow.file !== "";
    if (!hasContent) {
      if (level !== "" || explicitId !== "") {
        issues.push({
          row: sheetRow,
          ...(explicitId ? { id: explicitId } : {}),
          level: "warning",
          message: "Placeholder row (no airports) skipped.",
        });
      }
      continue;
    }

    const { row: fixed, warnings } = hasIdColumn ? { row: rawRow, warnings: [] as string[] } : applyCorrections(sheetRow, rawRow);

    const problems: string[] = [];
    const rank = rankFromDisplayName(level);
    if (!rank) problems.push(level === "" ? "Level is missing." : "Level is not one of Trainee, First Officer, Captain, Check Airman, Chief Pilot.");
    const check = validatePayload({ answer: fixed.answer, wrong: fixed.wrong, sourceFile: fixed.file });
    problems.push(...check.problems);

    let id: string | undefined;
    if (hasIdColumn) {
      id = explicitId;
      if (id === "") problems.push("Id is required when the sheet has an Id column.");
      else if (!AIRPORT_SPOTTER_ID.test(id)) problems.push("Id must look like apt-a12.");
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

    for (const message of warnings) issues.push({ row: sheetRow, ...(id ? { id } : {}), level: "warning", message });
    const sourceFile = String(check.data["sourceFile"]);
    if (!IMAGE_FILE.test(sourceFile)) {
      issues.push({
        row: sheetRow,
        ...(id ? { id } : {}),
        level: "warning",
        message: sourceFile === "" ? "File name is empty." : "File name has no .jpg/.jpeg/.png extension.",
      });
    }

    parsed.push({ row: sheetRow, id, naturalKey: sourceFile.normalize("NFC"), version, rank, data: check.data });
  }
  return { kind: hasIdColumn ? "admin_export" : "client_sheet", rows: parsed, issues };
}

function exportRows(items: readonly StoredItem[]): (string | number)[][] {
  const out: (string | number)[][] = [[...AIRPORT_SPOTTER_EXPORT_HEADER]];
  for (const item of items) {
    const data = item.data as { answer: string; wrong: string[]; sourceFile: string };
    out.push([
      item.id,
      item.version,
      isRank(item.rank) ? rankDisplayName(item.rank) : item.rank,
      data.answer,
      data.wrong[0] ?? "",
      data.wrong[1] ?? "",
      data.wrong[2] ?? "",
      data.sourceFile,
      item.status,
    ]);
  }
  return out;
}

export const airportSpotterMapping: ContentModuleMapping = {
  module: "airport-spotter",
  parse,
  validatePayload,
  naturalKey: (data) => String((data as { sourceFile?: unknown } | null)?.sourceFile ?? "").trim().normalize("NFC"),
  formatId: (n) => {
    const id = `apt-a${n}`;
    return Number.isSafeInteger(n) && AIRPORT_SPOTTER_ID.test(id) ? id : undefined;
  },
  idNumber: (id) => (AIRPORT_SPOTTER_ID.test(id) ? Number(id.slice("apt-a".length)) : undefined),
  exportRows,
};
