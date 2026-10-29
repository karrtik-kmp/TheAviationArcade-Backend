import { createHash } from "node:crypto";
import type { ContentModuleMapping, ImportIssue, ItemStatus, ParsedRow, SheetKind } from "./content-module.js";
import type { Rank } from "../rules/ranks.js";

export type ExistingItem = { id: string; rank: Rank; status: ItemStatus; version: number; data: unknown };

/** One changed field of an updated row, as the dry run shows it. `field` is e.g. `answer`, `wrong[1]`, `rank`, `status`. */
export type FieldDiff = { field: string; from: unknown; to: unknown };

export type PlannedRow = {
  row: number;
  id: string;
  action: "create" | "update" | "unchanged";
  rank: Rank;
  data: Record<string, unknown>;
  /** The stored version the row was planned against (matched rows only). The write must still find it. */
  expectedVersion?: number;
  /** For an update: what changes. */
  diff?: FieldDiff[];
  /** A client-sheet update of a retired item: it comes back as approved. */
  reactivate?: boolean;
};

/** A stored item a client sheet no longer lists. */
export type PlannedRetirement = { id: string; naturalKey: string; expectedVersion: number };

export type ImportPlan = {
  kind: SheetKind;
  /** What created/updated items record as their source. */
  source: "client_sheet" | "admin";
  rows: PlannedRow[];
  retirements: PlannedRetirement[];
  /** Conflicts and row errors found while planning. */
  issues: ImportIssue[];
  counts: { created: number; updated: number; unchanged: number; retired: number };
  /** A client-sheet import that overwrites or retires stored content must be confirmed with the dry run's planHash. */
  requiresConfirm: boolean;
};

/** JSON with sorted object keys, so two payloads compare equal whatever order jsonb returned them in. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, v]) => `${JSON.stringify(key)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function flatten(value: unknown, path: string, out: Map<string, unknown>): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => flatten(v, `${path}[${i}]`, out));
  } else if (value !== null && typeof value === "object") {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) flatten(v, path ? `${path}.${key}` : key, out);
  } else {
    out.set(path, value ?? null);
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Field-level differences between a stored item and the incoming rank and data. Sorted by field name. */
export function diffItem(stored: { rank: string; data: unknown }, incoming: { rank: string; data: unknown }): FieldDiff[] {
  const before = new Map<string, unknown>();
  const after = new Map<string, unknown>();
  flatten({ rank: stored.rank, ...asObject(stored.data) }, "", before);
  flatten({ rank: incoming.rank, ...asObject(incoming.data) }, "", after);
  const fields = [...new Set([...before.keys(), ...after.keys()])].sort();
  return fields
    .filter((field) => canonicalJson(before.get(field) ?? null) !== canonicalJson(after.get(field) ?? null))
    .map((field) => ({ field, from: before.get(field) ?? null, to: after.get(field) ?? null }));
}

const CONFLICT_HINT = "export, edit and re-import";

export type PlanOptions = {
  kind: SheetKind;
  mapping: Pick<ContentModuleMapping, "naturalKey" | "formatId" | "idNumber">;
};

/**
 * Decide what each parsed row does against the stored items. Pure, so the import runs it twice: once for
 * the dry run / early 422, and again under the module lock against the rows as they are right then.
 *
 * Client sheet (no Id column: the client's own spreadsheet; authoritative):
 * - Each row is matched to a stored item by natural key (exact). Unmatched rows are created with the next
 *   free id (highest numeric suffix + 1, in sheet order; in an empty module that is simply row order).
 * - A matched row with different rank or data is an update; a retired match comes back as approved.
 * - Stored approved items the file no longer lists are retired.
 * - A blank or repeated natural key is a row error, into an empty module too (user, 2026-10-28), so later
 *   sheets can always match by it: we never guess a match.
 *
 * Admin export (Id column: our export, edited): the Id is the identity.
 * - No Version: create if the id is new; unchanged if identical; otherwise a conflict.
 * - With Version: the id must exist and the version must equal the stored one; then update if it differs,
 *   else unchanged. Anything else is a conflict. Never retires; stored items absent from the file are untouched.
 * - A repeated id is an error.
 */
export function planImport(parsed: readonly ParsedRow[], existing: ReadonlyMap<string, ExistingItem>, options: PlanOptions): ImportPlan {
  const rows: PlannedRow[] = [];
  const issues: ImportIssue[] = [];
  const retirements: PlannedRetirement[] = [];
  const { kind, mapping } = options;

  const sameContent = (stored: ExistingItem, item: ParsedRow) =>
    stored.rank === item.rank && canonicalJson(stored.data) === canonicalJson(item.data);

  if (kind === "admin_export") {
    const seen = new Map<string, number>();
    let maxNumber = 0;
    // Resulting natural key per id: every stored item (retired too), then the file's rows on top.
    const keys = new Map<string, string>();
    for (const stored of existing.values()) {
      maxNumber = Math.max(maxNumber, mapping.idNumber(stored.id) ?? 0);
      keys.set(stored.id, mapping.naturalKey(stored.data));
    }
    const idCeiling = maxNumber + parsed.length; // new ids continue the sequence; they may not jump
    for (const item of parsed) {
      const id = item.id ?? "";
      const first = seen.get(id);
      if (first !== undefined) {
        issues.push({ row: item.row, id, level: "error", message: `Duplicate id (first used on row ${first}).` });
        continue;
      }
      seen.set(id, item.row);

      const stored = existing.get(id);
      const same = stored !== undefined && sameContent(stored, item);
      const base = { row: item.row, id, rank: item.rank, data: item.data };

      if (item.version === undefined) {
        if (!stored) {
          const number = mapping.idNumber(id);
          if (number === undefined || number > idCeiling) {
            issues.push({
              row: item.row,
              id,
              level: "error",
              message: `New ids must continue the existing sequence (at most ${mapping.formatId(idCeiling) ?? "the last valid id"} for this file).`,
            });
            continue;
          }
          rows.push({ ...base, action: "create" });
        } else if (same) rows.push({ ...base, action: "unchanged", expectedVersion: stored.version });
        else {
          issues.push({ row: item.row, id, level: "conflict", message: `Id already exists with different content; ${CONFLICT_HINT}.` });
        }
        continue;
      }

      if (!stored) {
        issues.push({ row: item.row, id, level: "conflict", message: `Version given but the id does not exist; ${CONFLICT_HINT}.` });
      } else if (stored.version !== item.version) {
        issues.push({
          row: item.row,
          id,
          level: "conflict",
          message: `Version ${item.version} is out of date (stored is ${stored.version}); ${CONFLICT_HINT}.`,
        });
      } else if (same) {
        rows.push({ ...base, action: "unchanged", expectedVersion: stored.version });
      } else {
        rows.push({ ...base, action: "update", expectedVersion: stored.version, diff: diffItem(stored, item) });
      }
    }

    // Natural keys stay unique and non-blank module-wide, so later client sheets can always match by them.
    for (const r of rows) if (r.action !== "unchanged") keys.set(r.id, mapping.naturalKey(r.data));
    const owners = new Map<string, string[]>();
    for (const [id, key] of keys) owners.set(key, [...(owners.get(key) ?? []), id]);
    for (const r of rows) {
      if (r.action === "unchanged") continue;
      const key = keys.get(r.id) ?? "";
      if (key === "") {
        issues.push({ row: r.row, id: r.id, level: "error", message: "File name is empty; every question needs a unique file name." });
        continue;
      }
      const others = (owners.get(key) ?? []).filter((other) => other !== r.id);
      if (others.length > 0) {
        issues.push({
          row: r.row,
          id: r.id,
          level: "error",
          message: `File name "${key}" is already used by ${others.join(", ")}; it must be unique across the module.`,
        });
      }
    }
  } else {
    const byKey = new Map<string, ExistingItem[]>();
    let maxNumber = 0;
    for (const stored of existing.values()) {
      const key = mapping.naturalKey(stored.data);
      byKey.set(key, [...(byKey.get(key) ?? []), stored]);
      maxNumber = Math.max(maxNumber, mapping.idNumber(stored.id) ?? 0);
    }
    const matching = existing.size > 0; // an empty module has nothing to match: ids are row order
    const seenKeys = new Map<string, number>();
    const matched = new Set<string>();

    for (const item of parsed) {
      const key = item.naturalKey;
      // Always required, even into an empty module (user, 2026-10-28): later sheets match by file name,
      // so every stored question must have a unique, non-blank one from the start.
      if (key === "") {
        issues.push({
          row: item.row,
          level: "error",
          message: "File name is empty; every row needs a unique file name so later sheets can match it to this question.",
        });
        continue;
      }
      const first = seenKeys.get(key);
      if (first !== undefined) {
        issues.push({
          row: item.row,
          level: "error",
          message: `File name "${key}" is repeated (first used on row ${first}); it must be unique to match rows to existing questions.`,
        });
        continue;
      }
      seenKeys.set(key, item.row);

      const candidates = matching ? (byKey.get(key) ?? []) : [];
      if (candidates.length > 1) {
        issues.push({
          row: item.row,
          level: "error",
          message: `File name "${key}" matches ${candidates.length} stored questions (${candidates.map((c) => c.id).join(", ")}); cannot tell which this row is.`,
        });
        continue;
      }
      const stored = candidates[0];
      if (!stored) {
        const id = mapping.formatId(maxNumber + 1);
        if (id === undefined) {
          issues.push({ row: item.row, level: "error", message: "Too many questions: there is no id left for this row." });
          continue;
        }
        maxNumber += 1;
        rows.push({ row: item.row, id, rank: item.rank, data: item.data, action: "create" });
        continue;
      }
      matched.add(stored.id);
      const base = { row: item.row, id: stored.id, rank: item.rank, data: item.data, expectedVersion: stored.version };
      const reactivate = stored.status === "retired";
      if (sameContent(stored, item) && !reactivate) {
        rows.push({ ...base, action: "unchanged" });
      } else {
        const diff = diffItem(stored, item);
        if (reactivate) diff.push({ field: "status", from: "retired", to: "approved" });
        rows.push({ ...base, action: "update", diff, ...(reactivate ? { reactivate: true } : {}) });
      }
    }

    for (const stored of existing.values()) {
      if (stored.status === "approved" && !matched.has(stored.id)) {
        retirements.push({ id: stored.id, naturalKey: mapping.naturalKey(stored.data), expectedVersion: stored.version });
      }
    }
    retirements.sort((a, b) => (mapping.idNumber(a.id) ?? 0) - (mapping.idNumber(b.id) ?? 0) || (a.id < b.id ? -1 : 1));
  }

  const count = (action: PlannedRow["action"]) => rows.filter((r) => r.action === action).length;
  const counts = { created: count("create"), updated: count("update"), unchanged: count("unchanged"), retired: retirements.length };
  return {
    kind,
    source: kind === "client_sheet" ? "client_sheet" : "admin",
    rows,
    retirements,
    issues,
    counts,
    requiresConfirm: kind === "client_sheet" && (counts.updated > 0 || counts.retired > 0),
  };
}

/**
 * sha256 over the canonical plan: every row's action, id, content, diff and the stored version it was
 * planned against, plus the retirements. Row numbers are left out. A dry run returns it; the apply must
 * present it, and it only matches while stored content is as the dry run saw it.
 */
export function planHash(plan: ImportPlan): string {
  const canonical = canonicalJson({
    kind: plan.kind,
    rows: plan.rows.map((r) => ({
      id: r.id,
      action: r.action,
      rank: r.rank,
      data: r.data,
      version: r.expectedVersion ?? null,
      diff: r.diff ?? null,
      reactivate: r.reactivate ?? false,
    })),
    retirements: plan.retirements.map((r) => ({ id: r.id, version: r.expectedVersion })),
  });
  return createHash("sha256").update(canonical).digest("hex");
}
