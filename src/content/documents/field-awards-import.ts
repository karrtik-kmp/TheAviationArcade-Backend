import { createHash } from "node:crypto";
import type { ImportIssue } from "../content-module.js";
import { canonicalJson } from "../import-plan.js";
import { SpreadsheetError } from "../xlsx.js";
import type { SheetRow } from "../xlsx.js";
import { STORED_AWARD } from "./drafts.js";

/**
 * Re-importing a later Field Awards sheet (slice A2, a follow-up of T6). Pure: parse the client's sheet, match its rows to the
 * awards, diff against the preview (the version in force with the draft overlay on top) and name every problem. The database side is
 * ContentAdminService.importFieldAwards; the result only ever becomes edits in the draft, never a published version.
 *
 * The client's sheet has three columns and no id: `Field Award` (the name), `Current criteria` and `Threshold` (free text such as
 * "100,000 Miles"). So:
 *  - a row is matched to an award by NAME (the catalog's `title`, which is the sheet's name cell; the Unity code ids differ from the
 *    sheet's own naming for 10 of the 28 awards, which is exactly why the catalog keeps title + id side by side). The titles of the
 *    version in force and of the draft count too, so a renamed award is still found by its current name.
 *  - title and criteria are the cells, trimmed and otherwise verbatim.
 *  - the target is read from the Threshold cell ONLY when that cell differs from the one the preview carries (`thresholdCell`); the import writes the new cell into the draft with it, so the next import compares against it;
 *    an unchanged cell keeps the target as it is (rulings such as Go Around = 1 live there). A changed cell must start with a whole
 *    number ("1,000 Miles" = 1000). A changed cell that cannot be read as one whole-number target ("15 Boeing + 15 Airbus", "Many Trips") is a
 *    WARNING, never a guess and never a block: the new cell is written, the target stays, and the award is flagged `targetNeedsRuling`
 *    (a staff PATCH of the target then sticks, and the same sheet plans nothing more for it).
 *  - the sheet has no `hidden` column, so `hidden` is never touched.
 */

export const AWARD_IMPORT_FIELDS = ["title", "criteria", "target", "thresholdCell"] as const;
export type AwardImportField = (typeof AWARD_IMPORT_FIELDS)[number];

export type SheetAward = { row: number; name: string; criteria: string; threshold: string };

/** An award as the preview holds it, plus the names a sheet row may call it by. */
export type BaseAward = {
  id: string;
  title: string;
  criteria: string;
  target: number;
  /** The Threshold cell of the version in force. */
  thresholdCell: string;
  /** Normalised names (see `normaliseName`) that identify this award. */
  names: readonly string[];
};

export type AwardChange = { field: AwardImportField; from: string | number; to: string | number };
export type PlannedAward = {
  id: string;
  changes: AwardChange[];
  /**
   * Present (true) when the Threshold cell changed but no single whole-number target can be read from it: the new cell is written, the
   * target stays as it is, and staff must rule the target (PATCH). Part of the plan, so the planHash covers it.
   */
  targetNeedsRuling?: true;
};

export type FieldAwardsPlan = {
  /** Awards with at least one change, in catalog order. */
  awards: PlannedAward[];
  counts: { rows: number; awardsChanged: number; awardsUnchanged: number; fieldChanges: number };
  issues: ImportIssue[];
};

const norm = (value: string) => value.normalize("NFC").replace(/\s+/g, " ").trim();
/** Case-insensitive, whitespace-collapsed name used only to find the award; the stored text is never normalised. */
export const normaliseName = (value: string): string => norm(value).toLowerCase();

const HEADER_NAME = ["field award", "name"];
const HEADER_CRITERIA = ["current criteria", "criteria"];
const HEADER_THRESHOLD = ["threshold"];

const cellText = (cell: unknown): string | undefined => {
  if (cell === null || cell === undefined) return "";
  if (typeof cell === "string") return cell.trim();
  if (typeof cell === "number" && Number.isFinite(cell)) return String(cell);
  return undefined; // boolean, date, anything else: not text
};

/** Reads the client's sheet. A missing header is a file-level problem (SpreadsheetError, 400); bad cells are row issues. */
export function parseFieldAwardsSheet(rows: readonly SheetRow[]): { rows: SheetAward[]; issues: ImportIssue[] } {
  const first = rows.findIndex((row) => row.some((cell) => cell !== null && String(cell).trim() !== ""));
  const header = first < 0 ? [] : (rows[first] ?? []).map((cell) => normaliseName(typeof cell === "string" ? cell : ""));
  const column = (names: string[]) => header.findIndex((cell) => names.includes(cell));
  const [nameAt, criteriaAt, thresholdAt] = [column(HEADER_NAME), column(HEADER_CRITERIA), column(HEADER_THRESHOLD)];
  if (nameAt < 0 || criteriaAt < 0 || thresholdAt < 0) {
    throw new SpreadsheetError('The first row must be the header "Field Award", "Current criteria", "Threshold".');
  }
  const out: SheetAward[] = [];
  const issues: ImportIssue[] = [];
  for (let index = first + 1; index < rows.length; index += 1) {
    const cells = rows[index] ?? [];
    const row = index + 1;
    if (cells.every((cell) => cell === null || String(cell).trim() === "")) continue; // a blank line
    const name = cellText(cells[nameAt]);
    const criteria = cellText(cells[criteriaAt]);
    const threshold = cellText(cells[thresholdAt]);
    const problem = (message: string) => issues.push({ row, level: "error", message });
    if (name === undefined || name === "") {
      problem(name === undefined ? "The Field Award name is not text." : "The Field Award name is missing.");
    } else if (criteria === undefined || criteria === "") {
      issues.push({ row, level: "error", message: `${name}: the criteria are ${criteria === undefined ? "not text" : "missing"}.` });
    } else if (threshold === undefined || threshold === "") {
      issues.push({ row, level: "error", message: `${name}: the threshold is ${threshold === undefined ? "not text" : "missing"}.` });
    } else {
      out.push({ row, name, criteria, threshold });
    }
  }
  return { rows: out, issues };
}

/** The whole number a changed Threshold cell starts with, or why there is none. */
export function targetFromThreshold(cell: string): { target: number } | { error: string } {
  const match = /^(\d{1,3}(?:,\d{3})+|\d+)/.exec(cell.trim());
  if (!match) return { error: `the threshold "${cell}" does not start with a whole number, so no target can be read from it.` };
  const rest = cell.trim().slice(match[0].length);
  if (/^[.,]\d/.test(rest)) return { error: `the threshold "${cell}" starts with a number that is not a whole number.` };
  if (/\d/.test(rest)) return { error: `the threshold "${cell}" contains more than one number, so no single target can be read from it; set the target by hand.` };
  const target = Number((match[1] ?? "").replace(/,/g, ""));
  if (!Number.isSafeInteger(target) || target <= 0) return { error: `the target ${match[1]} is not a whole number of at least 1.` };
  return { target };
}

/** Matches, diffs and reports. `base` is in catalog order. */
export function planFieldAwardsImport(sheet: readonly SheetAward[], parseIssues: readonly ImportIssue[], base: readonly BaseAward[]): FieldAwardsPlan {
  const issues: ImportIssue[] = [...parseIssues];
  const byName = new Map<string, Set<string>>();
  for (const award of base) {
    for (const name of award.names) byName.set(name, (byName.get(name) ?? new Set()).add(award.id));
  }
  const baseById = new Map(base.map((a) => [a.id, a]));
  const seen = new Map<string, number>(); // award id -> first row
  const changesById = new Map<string, AwardChange[]>();
  const needsRuling = new Set<string>();

  for (const entry of sheet) {
    const ids = [...(byName.get(normaliseName(entry.name)) ?? [])];
    if (ids.length === 0) {
      issues.push({ row: entry.row, level: "error", message: `"${entry.name}" is not a Field Award we have; awards cannot be added or renamed by an import.` });
      continue;
    }
    const id = ids[0] as string;
    if (ids.length > 1) {
      issues.push({ row: entry.row, level: "error", message: `"${entry.name}" names more than one Field Award (${ids.join(", ")}).` });
      continue;
    }
    const award = baseById.get(id) as BaseAward;
    const firstRow = seen.get(id);
    if (firstRow !== undefined) {
      issues.push({ row: entry.row, id, level: "error", message: `${award.title} is listed twice (rows ${firstRow} and ${entry.row}).` });
      continue;
    }
    seen.set(id, entry.row);

    const changes: AwardChange[] = [];
    if (entry.name !== award.title) changes.push({ field: "title", from: award.title, to: entry.name });
    if (entry.criteria !== award.criteria) changes.push({ field: "criteria", from: award.criteria, to: entry.criteria });
    let target = award.target;
    if (entry.threshold !== award.thresholdCell.trim()) {
      const read = targetFromThreshold(entry.threshold);
      // A readable number the stored limits would refuse is as unusable as an unreadable one.
      const usable = "error" in read ? read : STORED_AWARD.shape.target.safeParse(read.target).success ? read : { error: `the target ${read.target} is outside the allowed range.` };
      if ("error" in usable) {
        needsRuling.add(id);
        issues.push({ row: entry.row, id, level: "warning", message: `${award.title}: ${usable.error} The new threshold wording is saved and the target stays ${award.target}; staff must rule the target.` });
      } else target = usable.target;
    }
    if (target !== award.target) changes.push({ field: "target", from: award.target, to: target });
    // The cell moves with the target (and alone when only the wording changed), so "an unchanged cell keeps the target" holds after a publish.
    if (entry.threshold !== award.thresholdCell.trim()) changes.push({ field: "thresholdCell", from: award.thresholdCell, to: entry.threshold });

    // The same limits a PATCH of the draft enforces.
    const wanted = Object.fromEntries(changes.map((c) => [c.field, c.to]));
    const checked = STORED_AWARD.safeParse(wanted);
    if (!checked.success) {
      issues.push({ row: entry.row, id, level: "error", message: `${award.title}: ${checked.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}.` });
    }
    if (changes.length > 0) changesById.set(id, changes);
  }

  for (const award of base) {
    if (!seen.has(award.id)) issues.push({ row: 0, id: award.id, level: "error", message: `${award.title} is missing from the sheet; an import never removes an award.` });
  }

  const awards: PlannedAward[] = base.filter((a) => changesById.has(a.id)).map((a) => ({ id: a.id, changes: changesById.get(a.id) as AwardChange[], ...(needsRuling.has(a.id) ? { targetNeedsRuling: true as const } : {}) }));
  const fieldChanges = awards.reduce((n, a) => n + a.changes.length, 0);
  issues.sort((a, b) => a.row - b.row);
  return {
    awards,
    counts: { rows: sheet.length, awardsChanged: awards.length, awardsUnchanged: seen.size - awards.length, fieldChanges },
    issues,
  };
}

/** sha256 over the changes and the draft they were planned against: any change to either makes an earlier `confirm` stale. */
export function fieldAwardsPlanHash(basis: { publishedVersion: number | null; draftVersion: number }, plan: Pick<FieldAwardsPlan, "awards">): string {
  return createHash("sha256")
    .update(canonicalJson({ kind: "field-awards-import", publishedVersion: basis.publishedVersion, draftVersion: basis.draftVersion, awards: plan.awards }))
    .digest("hex");
}
