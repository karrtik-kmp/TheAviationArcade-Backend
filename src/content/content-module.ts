import type { ModuleId } from "../rules/modules.js";
import type { Rank } from "../rules/ranks.js";
import type { SheetRow } from "./xlsx.js";

/** One problem found in a row. `row` is the 1-based sheet row; 0 would mean "the file", which is never used. */
export type ImportIssue = {
  row: number;
  id?: string;
  level: "error" | "conflict" | "warning";
  message: string;
};

/**
 * Where a file came from. A client sheet has no Id column (the client's own spreadsheet): the planner
 * matches its rows to stored items by natural key and is authoritative. An admin export has an Id column
 * (our export, edited): rows carry their Id and Version, and it never retires anything.
 */
export type SheetKind = "client_sheet" | "admin_export";

/** A sheet row the module mapping accepted. `id` is set for an admin export and left to the planner for a client sheet. */
export type ParsedRow = {
  row: number;
  id: string | undefined;
  /** The module's natural key (Military: the trimmed `file` value). May be "" when the sheet left it blank. */
  naturalKey: string;
  /** From an optional Version column. Present = the caller edited a row it exported at this version. */
  version: number | undefined;
  rank: Rank;
  /** The module payload stored in content_items.data. */
  data: Record<string, unknown>;
};

export type ParsedSheet = { kind: SheetKind; rows: ParsedRow[]; issues: ImportIssue[] };

export type ItemStatus = "approved" | "retired";

/** A stored item as the exporter sees it. */
export type StoredItem = { id: string; rank: Rank; status: ItemStatus; version: number; data: unknown };

/**
 * How one module's spreadsheet maps to content_items. A module with no mapping cannot be imported (404).
 * Parsing may throw SpreadsheetError for file-level problems (header row not found).
 */
export interface ContentModuleMapping {
  readonly module: ModuleId;
  /** Parse the first worksheet. Row-level problems become issues; accepted rows are returned in sheet order. */
  parse(rows: SheetRow[]): ParsedSheet;
  /** Natural key of a stored payload; equals ParsedRow.naturalKey for the same question. */
  naturalKey(data: unknown): string;
  /** The id for the Nth item of the module (Military: mil-a<N>), or undefined when N is beyond what an id can express. */
  formatId(n: number): string | undefined;
  /** The N in an id made by formatId, or undefined for any other shape. */
  idNumber(id: string): number | undefined;
  /** Header row plus one row per item (retired ones too, with a Status column that import ignores), in the order given, in the client's column wording. */
  exportRows(items: readonly StoredItem[]): (string | number)[][];
}
