import { z } from "zod";
import { canonicalBytes, canonicalJson, sha256Hex } from "./canonical.js";

/**
 * The FAQ site document (docs/plans/faq-cms.md F2-F5). Pure: the `faq.v1` body schema, the text rule, the PATCH operations and
 * their application, and the change list. The database side is the shared draft/document machinery (content-admin.service.ts).
 *
 * The draft of the FAQ is the WHOLE working body (`edits.faq`, without `version`), not an overlay, because the FAQ is free structure.
 */
export const FAQ_FORMAT = "faq.v1";
export const MAX_FAQ_CATEGORIES = 30;
export const MAX_FAQ_ENTRIES = 300;
export const MAX_FAQ_OPERATIONS = 25;
const MAX_TITLE = 80;
const MAX_QUESTION = 200;
const MAX_ANSWER = 2000;

const FAQ_ID = /^[a-z0-9-]{1,64}$/;
// U+0000 or a lone surrogate: neither canonicalBytes nor jsonb can hold them.
const UNREPRESENTABLE = /\u0000|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
// Every control character (C0, DEL, C1) except \n. A tab or a bell in an FAQ text is a typing accident.
const CONTROL_EXCEPT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;
// Line/paragraph separators and the bidi controls: invisible, and they reorder or break displayed text.
const SEPARATORS_AND_BIDI = /[\u2028\u2029\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/;
const codePoints = (value: string) => [...value].length;

/** The shared checks, for a text that is already normalised (no CR) and trimmed. */
function textProblem(value: string, max: number, allowNewline: boolean): string | undefined {
  if (value.length === 0) return "must not be empty";
  if (codePoints(value) > max) return `must be at most ${max} characters`;
  if (UNREPRESENTABLE.test(value)) return "contains U+0000 or an unpaired surrogate";
  if (CONTROL_EXCEPT_NEWLINE.test(value)) return "contains a control character (tab, bell, ...)";
  if (SEPARATORS_AND_BIDI.test(value)) return "contains a line separator or a bidirectional control character";
  if (!allowNewline && value.includes("\n")) return "must be one line";
  return undefined;
}

/** Request text: CRLF and lone CR become LF, the ends are trimmed, then the text rule. */
const requestText = (max: number, allowNewline: boolean) =>
  z
    .string()
    .max(max * 4) // a cheap bound before the code-point count
    // Before the trim, which would silently drop a leading or trailing U+2028/U+2029.
    .refine((value) => !SEPARATORS_AND_BIDI.test(value), "contains a line separator or a bidirectional control character")
    .transform((value) => value.replace(/\r\n?/g, "\n").trim())
    .superRefine((value, ctx) => {
      const problem = textProblem(value, max, allowNewline);
      if (problem) ctx.addIssue({ code: "custom", message: problem });
    });

/** Stored text: must already be in normal form (a stored CR or untrimmed text is a bad row). */
const storedText = (max: number, allowNewline: boolean) =>
  z.string().superRefine((value, ctx) => {
    const problem = textProblem(value, max, allowNewline) ?? (value !== value.trim() ? "must be trimmed" : undefined);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  });

const id = z.string().regex(FAQ_ID, "an id is 1-64 characters of a-z, 0-9 and -");

// ---------------------------------------------------------------------------------------------------------------
// The body

const entrySchema = z.strictObject({ id, question: storedText(MAX_QUESTION, false), answer: storedText(MAX_ANSWER, true) });
const categorySchema = z.strictObject({ id, title: storedText(MAX_TITLE, false), entries: z.array(entrySchema).max(MAX_FAQ_ENTRIES) });

const faqBodySchema = z.strictObject({
  format: z.literal(FAQ_FORMAT),
  version: z.number().int().min(0),
  categories: z.array(categorySchema).max(MAX_FAQ_CATEGORIES),
});

/** The draft's working body: the document without its version (the version is assigned at publish). */
export const faqWorkingSchema = z.strictObject({ format: z.literal(FAQ_FORMAT), categories: z.array(categorySchema).max(MAX_FAQ_CATEGORIES) });

export type FaqEntry = z.infer<typeof entrySchema>;
export type FaqCategory = z.infer<typeof categorySchema>;
export type FaqWorking = z.infer<typeof faqWorkingSchema>;
export type FaqBody = z.infer<typeof faqBodySchema>;

export class FaqValidationError extends Error {}

/** The base before the first publish (F4): version 0, no categories. */
export const EMPTY_FAQ_WORKING: FaqWorking = { format: FAQ_FORMAT, categories: [] };

function checkUnique(categories: readonly FaqCategory[]): void {
  if (categories.reduce((n, c) => n + c.entries.length, 0) > MAX_FAQ_ENTRIES) throw new FaqValidationError(`faq: more than ${MAX_FAQ_ENTRIES} entries`);
  const categoryIds = new Set<string>();
  const entryIds = new Set<string>();
  for (const category of categories) {
    if (categoryIds.has(category.id)) throw new FaqValidationError(`faq: category ${category.id} appears twice`);
    categoryIds.add(category.id);
    for (const entry of category.entries) {
      if (entryIds.has(entry.id)) throw new FaqValidationError(`faq: entry ${entry.id} appears twice`);
      entryIds.add(entry.id);
    }
  }
}

function issues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join(".") || "$"}: ${i.message}`)
    .join("; ");
}

/** Validates a stored or about-to-be-stored faq.v1 body (version equal to the row's when given). Throws FaqValidationError. */
export function parseFaq(body: unknown, expectedVersion?: number): FaqBody {
  const parsed = faqBodySchema.safeParse(body);
  if (!parsed.success) throw new FaqValidationError(`faq: ${issues(parsed.error)}`);
  if (expectedVersion !== undefined && parsed.data.version !== expectedVersion) {
    throw new FaqValidationError(`faq: body version ${parsed.data.version} differs from the row version ${expectedVersion}`);
  }
  checkUnique(parsed.data.categories);
  return parsed.data;
}

/** The stored draft body, validated (throws FaqValidationError; the version is not part of it). */
export function parseFaqWorking(value: unknown): FaqWorking {
  const parsed = faqWorkingSchema.safeParse(value);
  if (!parsed.success) throw new FaqValidationError(`faq: ${issues(parsed.error)}`);
  checkUnique(parsed.data.categories);
  return parsed.data;
}

export function faqEntryCount(body: { categories: readonly { entries: readonly unknown[] }[] }): number {
  return body.categories.reduce((n, c) => n + c.entries.length, 0);
}

// ---------------------------------------------------------------------------------------------------------------
// Operations

// The shape bound is the largest valid index (a move inside the limits); a position past the END of the current list is a 422.
const categoryPosition = z.number().int().min(0).max(MAX_FAQ_CATEGORIES - 1);
const entryPosition = z.number().int().min(0).max(MAX_FAQ_ENTRIES - 1);

export const faqOperationSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("upsertCategory"), id, title: requestText(MAX_TITLE, false) }),
  z.strictObject({ op: z.literal("removeCategory"), id }),
  z.strictObject({ op: z.literal("moveCategory"), id, position: categoryPosition }),
  z.strictObject({ op: z.literal("upsertEntry"), categoryId: id, id, question: requestText(MAX_QUESTION, false), answer: requestText(MAX_ANSWER, true) }),
  z.strictObject({ op: z.literal("removeEntry"), id }),
  z.strictObject({ op: z.literal("moveEntry"), id, categoryId: id, position: entryPosition }),
]);
export type FaqOperation = z.infer<typeof faqOperationSchema>;

export const faqEditRequest = z.strictObject({
  draftVersion: z.number().int().min(0).max(2_000_000_000),
  operations: z.array(faqOperationSchema).min(1).max(MAX_FAQ_OPERATIONS),
});

/** A semantic refusal of one operation (422 content_invalid). `index` is the operation's 0-based position in the request. */
export class FaqOperationError extends Error {
  constructor(
    readonly index: number,
    message: string,
  ) {
    super(`Operation ${index} (${message})`);
  }
}

/** Applies the operations in order to a copy of `working`; the first refused one throws and nothing is returned (all or nothing). */
export function applyFaqOperations(working: FaqWorking, operations: readonly FaqOperation[]): FaqWorking {
  const body = structuredClone(working);
  const cats = body.categories;
  const findCategory = (categoryId: string) => cats.findIndex((c) => c.id === categoryId);
  const findEntry = (entryId: string): { category: FaqCategory; index: number } | undefined => {
    for (const category of cats) {
      const index = category.entries.findIndex((e) => e.id === entryId);
      if (index >= 0) return { category, index };
    }
    return undefined;
  };
  operations.forEach((operation, i) => {
    const refuse = (message: string): never => {
      throw new FaqOperationError(i, `${operation.op}: ${message}`);
    };
    switch (operation.op) {
      case "upsertCategory": {
        const at = findCategory(operation.id);
        if (at >= 0) cats[at]!.title = operation.title;
        else {
          if (cats.length >= MAX_FAQ_CATEGORIES) refuse(`at most ${MAX_FAQ_CATEGORIES} categories`);
          cats.push({ id: operation.id, title: operation.title, entries: [] });
        }
        return;
      }
      case "removeCategory": {
        const at = findCategory(operation.id);
        if (at < 0) refuse(`no category ${operation.id}`);
        if (cats[at]!.entries.length > 0) refuse(`category ${operation.id} still has entries; move or remove them first`);
        cats.splice(at, 1);
        return;
      }
      case "moveCategory": {
        const at = findCategory(operation.id);
        if (at < 0) refuse(`no category ${operation.id}`);
        if (operation.position > cats.length - 1) refuse(`position ${operation.position} is out of range 0..${cats.length - 1}`);
        const [moved] = cats.splice(at, 1);
        cats.splice(operation.position, 0, moved!);
        return;
      }
      case "upsertEntry": {
        const category = cats[findCategory(operation.categoryId)];
        if (!category) return refuse(`no category ${operation.categoryId}`);
        const existing = findEntry(operation.id);
        if (existing && existing.category !== category) refuse(`entry ${operation.id} is in category ${existing.category.id}; use moveEntry`);
        if (existing) {
          existing.category.entries[existing.index] = { id: operation.id, question: operation.question, answer: operation.answer };
          return;
        }
        if (faqEntryCount(body) >= MAX_FAQ_ENTRIES) refuse(`at most ${MAX_FAQ_ENTRIES} entries`);
        category.entries.push({ id: operation.id, question: operation.question, answer: operation.answer });
        return;
      }
      case "removeEntry": {
        const existing = findEntry(operation.id);
        if (!existing) return refuse(`no entry ${operation.id}`);
        existing.category.entries.splice(existing.index, 1);
        return;
      }
      case "moveEntry": {
        const existing = findEntry(operation.id);
        if (!existing) return refuse(`no entry ${operation.id}`);
        const target = cats[findCategory(operation.categoryId)];
        if (!target) return refuse(`no category ${operation.categoryId}`);
        const [moved] = existing.category.entries.splice(existing.index, 1);
        const last = target.entries.length; // the resulting list has length + 1 entries: valid positions 0..length
        if (operation.position > last) refuse(`position ${operation.position} is out of range 0..${last}`);
        target.entries.splice(operation.position, 0, moved!);
        return;
      }
    }
  });
  return body;
}

// ---------------------------------------------------------------------------------------------------------------
// Changes (view and audit)

export type FaqChange = { kind: string; key: string; field?: string; from?: unknown; to?: unknown };

/** True when two working bodies are the same document. */
export function sameFaq(a: FaqWorking, b: FaqWorking): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/**
 * What a publish (or the pending draft) changes, in document order. `before` undefined = nothing published (the empty base). A
 * move is reported for an item whose index among the items present in both versions changed.
 */
export function describeFaqChanges(before: FaqWorking, after: FaqWorking): FaqChange[] {
  const out: FaqChange[] = [];
  const oldCats = new Map(before.categories.map((c) => [c.id, c]));
  const newCats = new Map(after.categories.map((c) => [c.id, c]));
  const oldEntries = new Map<string, { entry: FaqEntry; categoryId: string }>();
  for (const c of before.categories) for (const e of c.entries) oldEntries.set(e.id, { entry: e, categoryId: c.id });
  const newEntries = new Map<string, { entry: FaqEntry; categoryId: string }>();
  for (const c of after.categories) for (const e of c.entries) newEntries.set(e.id, { entry: e, categoryId: c.id });

  const commonOrder = (ids: readonly string[], other: ReadonlyMap<string, unknown>) => ids.filter((x) => other.has(x));
  const catBefore = commonOrder(before.categories.map((c) => c.id), newCats);
  const catAfter = commonOrder(after.categories.map((c) => c.id), oldCats);

  for (const category of after.categories) {
    const was = oldCats.get(category.id);
    if (!was) out.push({ kind: "category-added", key: category.id, to: category.title });
    else {
      if (was.title !== category.title) out.push({ kind: "category-renamed", key: category.id, field: "title", from: was.title, to: category.title });
      if (catBefore.indexOf(category.id) !== catAfter.indexOf(category.id)) {
        out.push({ kind: "category-moved", key: category.id, from: catBefore.indexOf(category.id), to: catAfter.indexOf(category.id) });
      }
    }
  }
  for (const category of before.categories) if (!newCats.has(category.id)) out.push({ kind: "category-removed", key: category.id, from: category.title });

  for (const category of after.categories) {
    const inBefore = commonOrder((oldCats.get(category.id)?.entries ?? []).map((e) => e.id), new Map(category.entries.map((e) => [e.id, 1])));
    const inAfter = commonOrder(category.entries.map((e) => e.id), new Map((oldCats.get(category.id)?.entries ?? []).map((e) => [e.id, 1])));
    for (const entry of category.entries) {
      const was = oldEntries.get(entry.id);
      if (!was) {
        out.push({ kind: "entry-added", key: entry.id, to: entry.question });
        continue;
      }
      if (was.categoryId !== category.id) out.push({ kind: "entry-moved", key: entry.id, field: "category", from: was.categoryId, to: category.id });
      else if (inBefore.indexOf(entry.id) !== inAfter.indexOf(entry.id)) {
        out.push({ kind: "entry-moved", key: entry.id, field: "position", from: inBefore.indexOf(entry.id), to: inAfter.indexOf(entry.id) });
      }
      if (was.entry.question !== entry.question) out.push({ kind: "entry-edited", key: entry.id, field: "question", from: was.entry.question, to: entry.question });
      if (was.entry.answer !== entry.answer) out.push({ kind: "entry-edited", key: entry.id, field: "answer", from: was.entry.answer, to: entry.answer });
    }
  }
  for (const [entryId, was] of oldEntries) if (!newEntries.has(entryId)) out.push({ kind: "entry-removed", key: entryId, from: was.entry.question });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Export and import between hosts (F10)

export const FAQ_EXPORT_KIND = "faq-export";
/** The import route's own JSON limit (docs/plans/faq-cms.md F10): 300 entries of 2200 code points at 4 bytes each fit. */
export const FAQ_IMPORT_LIMIT = "3mb";

/** The digest of an export: the canonical bytes of { format, categories }, without `version`, so the same content has the same digest on every host. */
export function faqContentSha256(categories: FaqWorking["categories"]): string {
  return sha256Hex(canonicalBytes({ format: FAQ_FORMAT, categories }));
}

const HOST = /^[A-Za-z0-9.:\[\]-]{1,255}$/;
/** The request's host as the export reports it: informational only; anything odd is "unknown". */
export function exportSourceHost(hostname: string | undefined): string {
  return hostname !== undefined && HOST.test(hostname) ? hostname : "unknown";
}

const exportSchema = z.strictObject({
  kind: z.literal(FAQ_EXPORT_KIND),
  format: z.literal(FAQ_FORMAT),
  sourceHost: z.string().regex(HOST),
  sourceVersion: z.number().int().min(1).max(2_000_000_000),
  publishedAt: z.string().max(40),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  categories: z.array(categorySchema).max(MAX_FAQ_CATEGORIES),
});
export type FaqExport = z.infer<typeof exportSchema>;

export function buildFaqExport(input: { sourceHost: string; sourceVersion: number; publishedAt: string; categories: FaqWorking["categories"] }): FaqExport {
  return { kind: FAQ_EXPORT_KIND, format: FAQ_FORMAT, ...input, sha256: faqContentSha256(input.categories) };
}

/** The import request: only its own frame is a shape (400); everything inside `file` is judged by parseFaqExport (422). */
export const faqImportRequest = z.strictObject({
  draftVersion: z.number().int().min(0).max(2_000_000_000),
  file: z.record(z.string(), z.unknown()),
});

/** Strictly validates an uploaded export: kind, format, shape, F2/F3 and the digest. Throws FaqValidationError (a 422 for the caller). */
export function parseFaqExport(file: unknown): FaqExport {
  const parsed = exportSchema.safeParse(file);
  if (!parsed.success) {
    const own = file as { kind?: unknown; format?: unknown } | null;
    if (own?.kind !== FAQ_EXPORT_KIND) throw new FaqValidationError(`The file is not a FAQ export (kind must be "${FAQ_EXPORT_KIND}").`);
    if (own.format !== FAQ_FORMAT) throw new FaqValidationError(`The file has format ${JSON.stringify(own.format)}; this server reads "${FAQ_FORMAT}".`);
    throw new FaqValidationError(`The file is not a valid FAQ export: ${issues(parsed.error)}`);
  }
  checkUnique(parsed.data.categories);
  if (faqContentSha256(parsed.data.categories) !== parsed.data.sha256) {
    throw new FaqValidationError("The file's sha256 does not match its categories (the file was edited or damaged).");
  }
  return parsed.data;
}
