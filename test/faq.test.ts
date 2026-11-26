import { describe, expect, it } from "vitest";
import { canonicalBytes } from "../src/content/documents/canonical.js";
import { DOCUMENT_FORMAT, isDocumentName, isStoredDocumentName, validateDocument } from "../src/content/documents/documents.js";
import {
  EMPTY_FAQ_WORKING,
  FaqOperationError,
  applyFaqOperations,
  describeFaqChanges,
  faqEditRequest,
  faqOperationSchema,
  buildFaqExport,
  faqContentSha256,
  parseFaq,
  parseFaqExport,
} from "../src/content/documents/faq.js";
import type { FaqOperation, FaqWorking } from "../src/content/documents/faq.js";
import { CONTENT_DOCUMENT_NAMES, STORED_DOCUMENT_NAMES } from "../src/db/enums.js";

// docs/plans/faq-cms.md F1-F5: the faq.v1 body, the text rule and the operations. Pure; the routes are test/faq.e2e.test.ts.

const op = (value: unknown): FaqOperation => faqOperationSchema.parse(value);
const run = (working: FaqWorking, ...ops: unknown[]) => applyFaqOperations(working, ops.map(op));
const category = (id: string, ...entries: string[]) => ({ id, title: `T ${id}`, entries: entries.map((e) => ({ id: e, question: `Q ${e}`, answer: `A ${e}` })) });
const faq = (...categories: ReturnType<typeof category>[]): FaqWorking => ({ format: "faq.v1", categories });
const ids = (w: FaqWorking) => w.categories.map((c) => `${c.id}:${c.entries.map((e) => e.id).join(",")}`);
const refusedAt = (fn: () => unknown): number => {
  try {
    fn();
  } catch (error) {
    if (error instanceof FaqOperationError) return error.index;
    throw error;
  }
  throw new Error("expected a FaqOperationError");
};

describe("document names (F1)", () => {
  it("faq is a stored (site) document and not a game document", () => {
    expect([...STORED_DOCUMENT_NAMES].sort()).toEqual(["aircraft-tags", "clipper-cards", "faq", "field-awards"]);
    expect(CONTENT_DOCUMENT_NAMES as readonly string[]).not.toContain("faq");
    expect(isStoredDocumentName("faq")).toBe(true);
    expect(isDocumentName("faq")).toBe(false);
    expect(DOCUMENT_FORMAT.faq).toBe("faq.v1");
  });
});

describe("faq.v1 body (F2)", () => {
  const body = (categories: unknown, version = 1) => ({ format: "faq.v1", version, categories });

  it("accepts the empty base and a full document, and validateDocument agrees", () => {
    expect(() => parseFaq({ ...EMPTY_FAQ_WORKING, version: 0 })).not.toThrow();
    const good = body([category("a", "e1", "e2")]);
    expect(parseFaq(good, 1).categories).toHaveLength(1);
    expect(() => validateDocument("faq", good, 1)).not.toThrow();
    expect(() => validateDocument("faq", good, 2)).toThrow(/differs from the row version/);
  });

  it("refuses unknown keys, a bad format and bad ids", () => {
    expect(() => parseFaq({ ...body([]), extra: 1 })).toThrow();
    expect(() => parseFaq({ ...body([]), format: "faq.v2" })).toThrow();
    for (const bad of ["", "A", "a b", "a_b", "x".repeat(65), "é"]) {
      expect(() => parseFaq(body([category(bad)])), bad).toThrow();
      expect(() => parseFaq(body([category("ok", bad)])), bad).toThrow();
    }
  });

  it("refuses duplicate category ids and duplicate entry ids across the whole document", () => {
    expect(() => parseFaq(body([category("a"), category("a")]))).toThrow(/category a appears twice/);
    expect(() => parseFaq(body([category("a", "e1"), category("b", "e1")]))).toThrow(/entry e1 appears twice/);
  });

  it("holds at most 30 categories and 300 entries", () => {
    const thirty = Array.from({ length: 30 }, (_, i) => category(`c${i}`));
    expect(() => parseFaq(body(thirty))).not.toThrow();
    expect(() => parseFaq(body([...thirty, category("c30")]))).toThrow();
    const entries = (n: number) => Array.from({ length: n }, (_, i) => `e${i}`);
    expect(() => parseFaq(body([category("a", ...entries(300))]))).not.toThrow();
    expect(() => parseFaq(body([category("a", ...entries(301))]))).toThrow();
    expect(() => parseFaq(body([category("a", ...entries(150)), category("b", ...entries(151).map((e) => `x${e}`))]))).toThrow(/more than 300 entries/);
  });

  it("refuses stored text that is not in normal form (CR, tab, untrimmed, newline in a title or question)", () => {
    const entry = (patch: Record<string, string>) => body([{ id: "a", title: "T", entries: [{ id: "e", question: "Q", answer: "A", ...patch }] }]);
    expect(() => parseFaq(entry({ answer: "one\n\ntwo" }))).not.toThrow();
    expect(() => parseFaq(entry({ answer: "one\r\ntwo" }))).toThrow();
    expect(() => parseFaq(entry({ answer: "a\tb" }))).toThrow();
    expect(() => parseFaq(entry({ answer: " padded" }))).toThrow();
    expect(() => parseFaq(entry({ question: "two\nlines" }))).toThrow();
    expect(() => parseFaq(body([{ id: "a", title: "two\nlines", entries: [] }]))).toThrow();
  });

  it("has canonical bytes that do not depend on key order", () => {
    const a = { format: "faq.v1", version: 1, categories: [{ id: "a", title: "T", entries: [] }] };
    const b = { categories: [{ entries: [], title: "T", id: "a" }], version: 1, format: "faq.v1" };
    expect(canonicalBytes(a).equals(canonicalBytes(b))).toBe(true);
  });
});

describe("text rule (F3)", () => {
  const upsert = (patch: Record<string, unknown>) => ({ op: "upsertEntry", categoryId: "a", id: "e", question: "Q", answer: "A", ...patch });
  const accepted = (value: unknown) => faqOperationSchema.safeParse(value).success;
  const parsedAnswer = (answer: string) => (faqOperationSchema.parse(upsert({ answer })) as { answer: string }).answer;

  it("trims, and turns CRLF and lone CR into LF", () => {
    expect(parsedAnswer("  hello  ")).toBe("hello");
    expect(parsedAnswer("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
    expect(parsedAnswer("\n\n a \n")).toBe("a");
  });

  it("keeps inner newlines in an answer and refuses them in a title or a question", () => {
    expect(parsedAnswer("para one\n\npara two")).toBe("para one\n\npara two");
    expect(accepted(upsert({ question: "two\nlines" }))).toBe(false);
    expect(accepted(upsert({ question: "two\r\nlines" }))).toBe(false);
    expect(accepted({ op: "upsertCategory", id: "a", title: "two\nlines" })).toBe(false);
  });

  it("refuses an empty text, a tab, a bell, U+0000, DEL, a C1 control and a lone surrogate", () => {
    for (const bad of ["", "   ", "a\tb", "a\u0007b", "a\u0000b", "a\u007fb", "a\u0085b", "a\ud800b", "a\udc00b"]) {
      expect(accepted(upsert({ answer: bad })), JSON.stringify(bad)).toBe(false);
      expect(accepted(upsert({ question: bad })), JSON.stringify(bad)).toBe(false);
      expect(accepted({ op: "upsertCategory", id: "a", title: bad }), JSON.stringify(bad)).toBe(false);
    }
  });

  it("the position bounds are the largest valid index: category 29 and entry 299 are shapes, 30 and 300 are not", () => {
    expect(faqOperationSchema.safeParse({ op: "moveCategory", id: "a", position: 29 }).success).toBe(true);
    expect(faqOperationSchema.safeParse({ op: "moveCategory", id: "a", position: 30 }).success).toBe(false);
    expect(faqOperationSchema.safeParse({ op: "moveEntry", id: "e", categoryId: "a", position: 299 }).success).toBe(true);
    expect(faqOperationSchema.safeParse({ op: "moveEntry", id: "e", categoryId: "a", position: 300 }).success).toBe(false);
  });

  it("refuses U+2028, U+2029 and the bidi controls in a title, question and answer", () => {
    const bad = ["\u2028", "\u2029", "\u202a", "\u202b", "\u202c", "\u202d", "\u202e", "\u2066", "\u2067", "\u2068", "\u2069", "\u200e", "\u200f", "\u061c"];
    for (const c of bad) {
      for (const value of [`a${c}b`, `${c}a`, `a${c}`]) {
        const label = `U+${c.codePointAt(0)!.toString(16)} in ${JSON.stringify(value)}`;
        expect(accepted(upsert({ answer: value })), label).toBe(false);
        expect(accepted(upsert({ question: value })), label).toBe(false);
        expect(accepted({ op: "upsertCategory", id: "a", title: value }), label).toBe(false);
      }
    }
    expect(accepted(upsert({ answer: "plain é text" }))).toBe(true);
  });

  it("stored text and imports apply the same rule", () => {
    const withBidi = [category("a", "e1")];
    withBidi[0]!.entries[0]!.answer = "a\u202eb";
    expect(() => parseFaqExport(buildFaqExport({ sourceHost: "x", sourceVersion: 1, publishedAt: "p", categories: withBidi }))).toThrow();
  });

  it("counts code points: 80 / 200 / 2000 pass and one more fails, astral characters count once", () => {
    const plane = "\u{1F6E9}"; // one code point, two UTF-16 units
    for (const [field, max] of [["answer", 2000], ["question", 200]] as const) {
      expect(accepted(upsert({ [field]: "x".repeat(max) })), field).toBe(true);
      expect(accepted(upsert({ [field]: "x".repeat(max + 1) })), field).toBe(false);
      expect(accepted(upsert({ [field]: plane.repeat(max) })), `${field} astral`).toBe(true);
      expect(accepted(upsert({ [field]: plane.repeat(max + 1) })), `${field} astral over`).toBe(false);
    }
    expect(accepted({ op: "upsertCategory", id: "a", title: "x".repeat(80) })).toBe(true);
    expect(accepted({ op: "upsertCategory", id: "a", title: "x".repeat(81) })).toBe(false);
    expect(accepted({ op: "upsertCategory", id: "a", title: plane.repeat(80) })).toBe(true);
    expect(accepted({ op: "upsertCategory", id: "a", title: plane.repeat(81) })).toBe(false);
  });
});

describe("operations shape (F5)", () => {
  it("refuses unknown ops, unknown keys, bad ids and bad positions", () => {
    for (const bad of [
      { op: "rename", id: "a" },
      { op: "removeCategory", id: "a", extra: 1 },
      { op: "removeCategory", id: "A" },
      { op: "moveCategory", id: "a", position: -1 },
      { op: "moveCategory", id: "a", position: 1.5 },
      { op: "moveCategory", id: "a", position: 30 },
      { op: "moveEntry", id: "e", categoryId: "a", position: 300 },
      { op: "moveEntry", id: "e", categoryId: "a", position: -1 },
      { op: "moveEntry", id: "e", categoryId: "a" },
      { op: "upsertEntry", id: "e", question: "Q", answer: "A" },
    ]) {
      expect(faqOperationSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("takes 1 to 25 operations and a draftVersion", () => {
    const one = { op: "removeEntry", id: "e" };
    expect(faqEditRequest.safeParse({ draftVersion: 0, operations: [] }).success).toBe(false);
    expect(faqEditRequest.safeParse({ draftVersion: 0, operations: Array(25).fill(one) }).success).toBe(true);
    expect(faqEditRequest.safeParse({ draftVersion: 0, operations: Array(26).fill(one) }).success).toBe(false);
    expect(faqEditRequest.safeParse({ operations: [one] }).success).toBe(false);
    expect(faqEditRequest.safeParse({ draftVersion: 0, operations: [one], extra: 1 }).success).toBe(false);
  });
});

describe("applying operations (F5)", () => {
  it("upsertCategory appends a new category and renames an existing one", () => {
    const a = run(EMPTY_FAQ_WORKING, { op: "upsertCategory", id: "a", title: "A" }, { op: "upsertCategory", id: "b", title: "B" });
    expect(ids(a)).toEqual(["a:", "b:"]);
    const renamed = run(faq(category("a", "e1"), category("b")), { op: "upsertCategory", id: "a", title: "New" });
    expect(renamed.categories[0]).toEqual({ id: "a", title: "New", entries: [{ id: "e1", question: "Q e1", answer: "A e1" }] });
    expect(ids(renamed)).toEqual(["a:e1", "b:"]);
  });

  it("removeCategory removes an empty one and refuses a non-empty or unknown one", () => {
    expect(ids(run(faq(category("a"), category("b", "e1")), { op: "removeCategory", id: "a" }))).toEqual(["b:e1"]);
    expect(refusedAt(() => run(faq(category("a", "e1")), { op: "removeCategory", id: "a" }))).toBe(0);
    expect(refusedAt(() => run(faq(category("a")), { op: "removeCategory", id: "zz" }))).toBe(0);
  });

  it("moveCategory uses the index in the resulting list", () => {
    const start = faq(category("a"), category("b"), category("c"));
    expect(ids(run(start, { op: "moveCategory", id: "a", position: 2 }))).toEqual(["b:", "c:", "a:"]);
    expect(ids(run(start, { op: "moveCategory", id: "c", position: 0 }))).toEqual(["c:", "a:", "b:"]);
    expect(ids(run(start, { op: "moveCategory", id: "b", position: 1 }))).toEqual(["a:", "b:", "c:"]);
    expect(refusedAt(() => run(start, { op: "moveCategory", id: "a", position: 3 }))).toBe(0);
    expect(refusedAt(() => run(start, { op: "moveCategory", id: "zz", position: 0 }))).toBe(0);
  });

  it("upsertEntry appends a new entry, updates one in place, and refuses an entry that lives in another category", () => {
    const start = faq(category("a", "e1", "e2"), category("b", "e3"));
    const added = run(start, { op: "upsertEntry", categoryId: "a", id: "e9", question: "Q9", answer: "A9" });
    expect(ids(added)).toEqual(["a:e1,e2,e9", "b:e3"]);
    const updated = run(start, { op: "upsertEntry", categoryId: "a", id: "e1", question: "New Q", answer: "New A" });
    expect(ids(updated)).toEqual(["a:e1,e2", "b:e3"]);
    expect(updated.categories[0]!.entries[0]).toEqual({ id: "e1", question: "New Q", answer: "New A" });
    expect(refusedAt(() => run(start, { op: "upsertEntry", categoryId: "b", id: "e1", question: "Q", answer: "A" }))).toBe(0);
    expect(refusedAt(() => run(start, { op: "upsertEntry", categoryId: "zz", id: "e9", question: "Q", answer: "A" }))).toBe(0);
  });

  it("removeEntry removes one and refuses an unknown id", () => {
    expect(ids(run(faq(category("a", "e1", "e2")), { op: "removeEntry", id: "e1" }))).toEqual(["a:e2"]);
    expect(refusedAt(() => run(faq(category("a", "e1")), { op: "removeEntry", id: "zz" }))).toBe(0);
  });

  it("moveEntry works within a category and across categories, with positions in the resulting list", () => {
    const start = faq(category("a", "e1", "e2", "e3"), category("b", "e4"));
    expect(ids(run(start, { op: "moveEntry", id: "e1", categoryId: "a", position: 2 }))).toEqual(["a:e2,e3,e1", "b:e4"]);
    expect(ids(run(start, { op: "moveEntry", id: "e3", categoryId: "a", position: 0 }))).toEqual(["a:e3,e1,e2", "b:e4"]);
    expect(ids(run(start, { op: "moveEntry", id: "e1", categoryId: "b", position: 0 }))).toEqual(["a:e2,e3", "b:e1,e4"]);
    expect(ids(run(start, { op: "moveEntry", id: "e1", categoryId: "b", position: 1 }))).toEqual(["a:e2,e3", "b:e4,e1"]);
    // Out of range: within a (3 entries) the last index is 2; into b (1 entry + the moved one) it is 1.
    expect(refusedAt(() => run(start, { op: "moveEntry", id: "e1", categoryId: "a", position: 3 }))).toBe(0);
    expect(refusedAt(() => run(start, { op: "moveEntry", id: "e1", categoryId: "b", position: 2 }))).toBe(0);
    expect(refusedAt(() => run(start, { op: "moveEntry", id: "zz", categoryId: "b", position: 0 }))).toBe(0);
    expect(refusedAt(() => run(start, { op: "moveEntry", id: "e1", categoryId: "zz", position: 0 }))).toBe(0);
  });

  it("a moved entry may go into a category that was just created, in the same request", () => {
    const out = run(faq(category("a", "e1")), { op: "upsertCategory", id: "b", title: "B" }, { op: "moveEntry", id: "e1", categoryId: "b", position: 0 }, { op: "removeCategory", id: "a" });
    expect(ids(out)).toEqual(["b:e1"]);
  });

  it("names the failing operation's index, and is all or nothing (the input is never changed)", () => {
    const start = faq(category("a", "e1"));
    const before = JSON.stringify(start);
    const bad = [
      { op: "upsertCategory", id: "b", title: "B" },
      { op: "upsertEntry", categoryId: "b", id: "e2", question: "Q", answer: "A" },
      { op: "removeEntry", id: "nope" },
      { op: "upsertCategory", id: "c", title: "C" },
    ];
    expect(refusedAt(() => run(start, ...bad))).toBe(2);
    expect(JSON.stringify(start)).toBe(before);
  });

  it("enforces 30 categories and 300 entries while applying", () => {
    const thirty = faq(...Array.from({ length: 30 }, (_, i) => category(`c${i}`)));
    expect(refusedAt(() => run(thirty, { op: "upsertCategory", id: "extra", title: "X" }))).toBe(0);
    expect(ids(run(thirty, { op: "upsertCategory", id: "c0", title: "Renamed" })).length).toBe(30);
    const full = faq(category("a", ...Array.from({ length: 300 }, (_, i) => `e${i}`)));
    expect(refusedAt(() => run(full, { op: "upsertEntry", categoryId: "a", id: "more", question: "Q", answer: "A" }))).toBe(0);
    expect(ids(run(full, { op: "upsertEntry", categoryId: "a", id: "e5", question: "Q", answer: "A" })).length).toBe(1);
  });

  it("applies 25 operations in order", () => {
    const ops = Array.from({ length: 25 }, (_, i) => ({ op: "upsertEntry", categoryId: "a", id: `e${i}`, question: `Q${i}`, answer: `A${i}` }));
    const out = run(faq(category("a")), ...ops);
    expect(out.categories[0]!.entries.map((e) => e.id)).toEqual(ops.map((o) => o.id));
  });
});

describe("change list", () => {
  it("is empty for equal bodies and describes adds, edits, renames, moves and removals", () => {
    const before = faq(category("a", "e1", "e2"), category("b", "e3"), category("old"));
    expect(describeFaqChanges(before, before)).toEqual([]);
    expect(describeFaqChanges(EMPTY_FAQ_WORKING, faq(category("a", "e1")))).toEqual([
      { kind: "category-added", key: "a", to: "T a" },
      { kind: "entry-added", key: "e1", to: "Q e1" },
    ]);
    const after = run(
      before,
      { op: "upsertCategory", id: "a", title: "Renamed" },
      { op: "upsertEntry", categoryId: "a", id: "e1", question: "Q e1", answer: "changed" },
      { op: "moveEntry", id: "e3", categoryId: "a", position: 0 },
      { op: "removeEntry", id: "e2" },
      { op: "removeCategory", id: "old" },
      { op: "moveCategory", id: "b", position: 0 },
    );
    const kinds = describeFaqChanges(before, after).map((c) => `${c.kind}:${c.key}${c.field ? `.${c.field}` : ""}`);
    expect(kinds.sort()).toEqual(
      ["category-moved:a", "category-moved:b", "category-removed:old", "category-renamed:a.title", "entry-edited:e1.answer", "entry-moved:e3.category", "entry-removed:e2"].sort(),
    );
  });
});

describe("export file (F10)", () => {
  const categories = [category("a", "e1", "e2")];
  const file = () => buildFaqExport({ sourceHost: "dev.example.com", sourceVersion: 4, publishedAt: "2026-11-26T10:00:00.000Z", categories });

  it("the digest is over { format, categories } only, so it does not depend on the version or host", () => {
    const a = file();
    const b = buildFaqExport({ sourceHost: "other", sourceVersion: 9, publishedAt: "2027-01-01T00:00:00.000Z", categories });
    expect(a.sha256).toBe(b.sha256);
    expect(a.sha256).toBe(faqContentSha256(categories));
    expect(buildFaqExport({ sourceHost: "x", sourceVersion: 1, publishedAt: "p", categories: [category("a", "e1")] }).sha256).not.toBe(a.sha256);
    expect(Object.keys(a).sort()).toEqual(["categories", "format", "kind", "publishedAt", "sha256", "sourceHost", "sourceVersion"]);
  });

  it("parses its own output and refuses a changed digest, kind, format, key or text", () => {
    expect(parseFaqExport(file()).categories).toEqual(categories);
    expect(() => parseFaqExport({ ...file(), sha256: "1".repeat(64) })).toThrow(/sha256/);
    expect(() => parseFaqExport({ ...file(), kind: "x" })).toThrow(/kind/);
    expect(() => parseFaqExport({ ...file(), format: "faq.v2" })).toThrow(/format/);
    expect(() => parseFaqExport({ ...file(), extra: 1 })).toThrow();
    expect(() => parseFaqExport(null)).toThrow();
    const tab = [category("a", "e1")];
    tab[0]!.entries[0]!.answer = "a\tb";
    expect(() => parseFaqExport(buildFaqExport({ sourceHost: "x", sourceVersion: 1, publishedAt: "p", categories: tab }))).toThrow();
  });
});
