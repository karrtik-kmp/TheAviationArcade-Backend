import type { ContentModuleMapping, ImportIssue, PayloadCheck, ParsedRow, ParsedSheet, StoredItem } from "../content-module.js";
import { SpreadsheetError } from "../xlsx.js";
import type { Cell, SheetRow } from "../xlsx.js";
import { isRank } from "../../rules/ranks.js";
import { rankDisplayName, rankFromDisplayName } from "../../rules/catalog.js";

/**
 * Aircraft Identifier (commercial; module `identifier`) from the client's sheet "Airplane Identifier v1.xlsx" of
 * 2026-09-28: header on sheet row 3 (found by scanning the first rows), then one photo question per row. Extra columns
 * (folder, H/V, Resolution) are ignored; there is no photographer column, so the payload is `{ answer, wrong[3],
 * sourceFile }` and the credit lives on the photo (as for Airport Spotter).
 *
 * IDS COME FROM THE SHEET (`keyIsId`), exactly as Unity's `Tools/ContentImport/import_client_content.py` makes them: the
 * id is the corrected file's stem (`ai-a11.jpg` -> `ai-a11`), and the k-th KEPT row on the same photo gets `-k` for k >= 2
 * (`ai-a11-2`). They are not a dense sequence (the client's rows 11 and 18 are left out, see below).
 *
 * CORRECTIONS: only Unity's two logged fix kinds, each a warning "Corrected on import: ..." (client sheets only; an
 * admin export, our own file, is taken as written):
 * - `\bBoing\b` -> `Boeing` in the four answer labels;
 * - a file name `<stem>/<jpg|jpeg|png>` (or `\`) -> `<stem>.<ext lower-case>`.
 * Order per row, as Unity: file fix, label fixes, leave-out check, then `validatePayload`.
 *
 * LEFT OUT (as Unity's `validation_problem`; ASSUMPTION: the backend reports what Unity reports instead of refusing the
 * whole file, so the two import the same 31 questions): a row with an empty answer cell, the correct answer repeated as
 * a wrong one (case-insensitive), or two equal wrong answers. Each is a warning "Left out: ..." and takes no id. A row
 * Unity keeps but `validatePayload` refuses (e.g. a difference only in inner whitespace) is an error, never dropped.
 * The photo-in-delivery check of Unity's predicate does not exist here: the backend holds no photo folder.
 */

/** `ai-a<N>`, optionally `-<k>` for the k-th question on the same photo (k = 2..999). */
export const IDENTIFIER_ID = /^ai-a([1-9]\d{0,5})(?:-(?:[2-9]|[1-9]\d{1,2}))?$/;

const REQUIRED_HEADERS = ["level", "correct answer", "wrong answer 1", "wrong answer 2", "wrong answer 3", "file"] as const;
const HEADER_SCAN_ROWS = 10;
const IMAGE_FILE = /\.(jpe?g|png)$/i;
const BOING = /\bBoing\b/;
const BOING_ALL = /\bBoing\b/g;
const SLASH_EXTENSION = /^(.+)[/\\](jpe?g|png)$/i;

export const IDENTIFIER_EXPORT_HEADER = [
  "Id",
  "Version",
  "Level",
  "Correct Answer",
  "Wrong Answer 1",
  "Wrong Answer 2",
  "Wrong Answer 3",
  "file",
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

/** Python's str.casefold() for the text that occurs here: lower-casing plus the German sharp s. */
function casefold(value: string): string {
  return value.toLowerCase().replace(/ß/g, "ss");
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
  throw new SpreadsheetError("Could not find the header row (Level, Correct Answer, Wrong Answer 1-3, file) in the first 10 rows.");
}

function parseVersion(raw: Cell | undefined): number | undefined | "invalid" {
  const value = text(raw);
  if (value === "") return undefined;
  if (!/^[1-9]\d{0,8}$/.test(value)) return "invalid";
  return Number(value);
}

const PAYLOAD_KEYS = ["answer", "wrong", "sourceFile"] as const;

/**
 * The Identifier payload rules, shared by the sheet parser and the staff edit endpoint: `{ answer, wrong[3], sourceFile }`,
 * all strings, no other keys; answer and the three wrong answers present after trimming and all four distinct after
 * normalising (trim, collapse whitespace, lower-case). `sourceFile` may be blank here: an import only warns.
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
  const answer = str(record["answer"], "Correct Answer");
  const sourceFile = str(record["sourceFile"], "file");
  let wrong: string[] = ["", "", ""];
  if (Array.isArray(record["wrong"]) && record["wrong"].length === 3) {
    wrong = record["wrong"].map((value, i) => str(value, `Wrong Answer ${i + 1}`));
  } else {
    problems.push("wrong must be exactly three answers.");
  }
  if (answer === "") problems.push("Correct Answer is missing.");
  wrong.forEach((value, i) => {
    if (value === "") problems.push(`Wrong Answer ${i + 1} is missing.`);
  });
  if (answer !== "" && wrong.every((value) => value !== "")) {
    const options = [answer, ...wrong].map(normalise);
    if (new Set(options).size !== options.length) problems.push("The correct and wrong answers must all be different.");
  }
  return { data: { answer, wrong, sourceFile }, problems };
}

/** Unity's `validation_problem` without the photo check: why the question cannot be dealt, or undefined. */
function leaveOutReason(answer: string, wrong: readonly string[]): string | undefined {
  if (!answer || wrong.some((label) => !label)) return "an answer cell is empty";
  const folded = wrong.map(casefold);
  if (folded.includes(casefold(answer))) return `the correct answer \`${answer}\` is also listed as a wrong answer`;
  if (new Set(folded).size < folded.length) return "two wrong answers are the same, so the player would see duplicate choices";
  return undefined;
}

/** The file name without its last extension, as Python's Path(name).stem. */
function stemOf(file: string): string {
  const dot = file.lastIndexOf(".");
  return dot > 0 ? file.slice(0, dot) : file;
}

function parse(rows: SheetRow[]): ParsedSheet {
  const { rowIndex: headerIndex, columns } = findHeader(rows);
  const cell = (row: SheetRow, name: string): string => text(row[columns.get(name) ?? -1]);
  const hasIdColumn = columns.has("id");
  const hasVersionColumn = columns.has("version");
  const parsed: ParsedRow[] = [];
  const issues: ImportIssue[] = [];
  const usesPerStem = new Map<string, number>();

  for (let index = headerIndex + 1; index < rows.length; index++) {
    const row = rows[index] ?? [];
    const sheetRow = index + 1;
    const level = cell(row, "level");
    let answer = cell(row, "correct answer");
    let wrong = [cell(row, "wrong answer 1"), cell(row, "wrong answer 2"), cell(row, "wrong answer 3")];
    let sourceFile = cell(row, "file");
    const explicitId = hasIdColumn ? cell(row, "id") : "";

    // Unity skips a row with neither an answer nor a file; one with a Level or other cells only is worth a mention.
    if (answer === "" && sourceFile === "") {
      if (level !== "" || explicitId !== "" || wrong.some((value) => value !== "")) {
        issues.push({
          row: sheetRow,
          ...(explicitId ? { id: explicitId } : {}),
          level: "warning",
          message: "Placeholder row (no answer and no file) skipped.",
        });
      }
      continue;
    }

    const warnings: string[] = [];
    if (!hasIdColumn) {
      // 1. the file name fix
      const slash = SLASH_EXTENSION.exec(sourceFile);
      if (slash) {
        const fixed = `${slash[1]}.${(slash[2] ?? "").toLowerCase()}`;
        warnings.push(`Corrected on import: file name \`${sourceFile}\` corrected to \`${fixed}\`.`);
        sourceFile = fixed;
      }
      // 2. the label fixes
      const fixLabel = (label: string, name: string): string => {
        if (!BOING.test(label)) return label;
        warnings.push(`Corrected on import: ${name} "Boing" corrected to "Boeing" (\`${label}\`).`);
        return label.replace(BOING_ALL, "Boeing");
      };
      answer = fixLabel(answer, "Correct Answer");
      wrong = wrong.map((label, i) => fixLabel(label, `Wrong Answer ${i + 1}`));
      // 3. Unity's leave-out check, before any validation
      const reason = leaveOutReason(answer, wrong);
      if (reason !== undefined) {
        // Unity logs the fixes it made to a row it then leaves out, so they stay visible here too.
        for (const message of warnings) issues.push({ row: sheetRow, level: "warning", message });
        issues.push({
          row: sheetRow,
          level: "warning",
          message: `Left out: ${reason}. Row ${sheetRow} (\`${stemOf(sourceFile)}\`). Answers: ${answer} / ${wrong.join(" / ")}`,
        });
        continue;
      }
    }

    const problems: string[] = [];
    const rank = rankFromDisplayName(level);
    if (!rank) problems.push(level === "" ? "Level is missing." : "Level is not one of Trainee, First Officer, Captain, Check Airman, Chief Pilot.");
    const check = validatePayload({ answer, wrong, sourceFile });
    problems.push(...check.problems);

    let id: string | undefined;
    if (hasIdColumn) {
      id = explicitId;
      if (id === "") problems.push("Id is required when the sheet has an Id column.");
      else if (!IDENTIFIER_ID.test(id)) problems.push("Id must look like ai-a12 or ai-a12-2.");
    } else {
      const stem = stemOf(sourceFile);
      const uses = (usesPerStem.get(stem) ?? 0) + 1;
      usesPerStem.set(stem, uses);
      id = uses === 1 ? stem : `${stem}-${uses}`;
      if (!IDENTIFIER_ID.test(id)) {
        problems.push(
          sourceFile === ""
            ? "File name is empty; the file name gives the question its id (ai-a12.jpg)."
            : `The file name "${sourceFile}" does not give a valid id (ai-a12.jpg, a second question on the photo becomes ai-a12-2).`,
        );
      }
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

    for (const message of warnings) issues.push({ row: sheetRow, id, level: "warning", message });
    const kept = String(check.data["sourceFile"]);
    if (!IMAGE_FILE.test(kept)) {
      issues.push({ row: sheetRow, id, level: "warning", message: kept === "" ? "File name is empty." : "File name has no .jpg/.jpeg/.png extension." });
    }

    // keyIsId: the natural key IS the id. A client sheet leaves `id` to the planner; an admin export carries it.
    parsed.push({ row: sheetRow, id: hasIdColumn ? id : undefined, naturalKey: id, version, rank, data: check.data });
  }
  return { kind: hasIdColumn ? "admin_export" : "client_sheet", rows: parsed, issues };
}

function exportRows(items: readonly StoredItem[]): (string | number)[][] {
  const out: (string | number)[][] = [[...IDENTIFIER_EXPORT_HEADER]];
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

export const aircraftIdentifierMapping: ContentModuleMapping = {
  module: "identifier",
  parse,
  validatePayload,
  keyIsId: true,
  // Display only (the planner matches by id): the photo the question is on.
  naturalKey: (data) => String((data as { sourceFile?: unknown } | null)?.sourceFile ?? "").trim().normalize("NFC"),
  formatId: (n) => {
    const id = `ai-a${n}`;
    return Number.isSafeInteger(n) && IDENTIFIER_ID.test(id) ? id : undefined;
  },
  // ai-a11 and ai-a11-2 both give 11: the number is the photo's, the suffix is the k-th question on it.
  idNumber: (id) => {
    const match = IDENTIFIER_ID.exec(id);
    return match ? Number(match[1]) : undefined;
  },
  exportRows,
};
