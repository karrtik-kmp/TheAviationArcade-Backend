import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { ERROR_CODES } from "../src/common/errors.js";
import {
  EDIT_REQUESTS,
  applyCardNames,
  applyFieldAwardEdits,
  applyTagEdits,
  describeChanges,
  mergeEdits,
  parseStoredEdits,
  publishRequest,
  salvageHistory,
  sameContent,
  unacknowledgedClientRemovals,
  versionOnlyRequest,
  withHistory,
  editorsOf,
} from "../src/content/documents/drafts.js";
import { buildAircraftTagsBody, buildClipperCardsBody, buildFieldAwardsBody, validateDocument } from "../src/content/documents/documents.js";
import { ADMIN_AUDIT_ACTIONS } from "../src/db/enums.js";
import { FIELD_AWARD_IDS } from "../src/rules/field-awards.js";

// Slice T6, pure parts: the edit requests, the overlay merge and apply, the change list, and the rule that only draft-store.ts
// writes content_drafts. The database parts are in content-publish.e2e.test.ts.

const awards = EDIT_REQUESTS["field-awards"];
const ok = (draftVersion: number, award: Record<string, unknown>) => awards.safeParse({ draftVersion, awards: [award] });

describe("field-awards edit request", () => {
  it("accepts title, criteria, target and hidden, trimmed", () => {
    const parsed = ok(3, { id: "century", title: "  A title ", criteria: " c ", target: 120, hidden: true });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.awards[0]).toEqual({ id: "century", title: "A title", criteria: "c", target: 120, hidden: true });
  });

  it("refuses the id's neighbours: metric, sheet fields, rulings, anything unknown", () => {
    for (const extra of ["metric", "sheetId", "sheetRow", "thresholdCell", "rulings", "provisional", "miles"]) {
      expect(ok(0, { id: "century", title: "x", [extra]: 1 }).success, extra).toBe(false);
    }
  });

  it("targets are integers from 1 to 1e9", () => {
    for (const target of [1, 2, 1_000_000_000]) expect(ok(0, { id: "century", target }).success, String(target)).toBe(true);
    for (const target of [0, -1, 1.5, 1_000_000_001, "3", null, Number.NaN]) expect(ok(0, { id: "century", target }).success, String(target)).toBe(false);
  });

  it("an award needs at least one field, an id of the 28, and each id once", () => {
    expect(ok(0, { id: "century" }).success).toBe(false);
    expect(ok(0, { id: "no-such", title: "x" }).success).toBe(false);
    expect(awards.safeParse({ draftVersion: 0, awards: [{ id: "century", title: "a" }, { id: "century", title: "b" }] }).success).toBe(false);
    expect(awards.safeParse({ draftVersion: 0, awards: [] }).success).toBe(false);
    expect(awards.safeParse({ draftVersion: 0, awards: FIELD_AWARD_IDS.map((id) => ({ id, hidden: false })) }).success).toBe(true);
  });

  it("text must be representable: no U+0000, no unpaired surrogate, within the limits", () => {
    for (const title of ["a\u0000b", "a\ud800b", "\udc00", "", "   ", "x".repeat(201)]) expect(ok(0, { id: "century", title }).success, JSON.stringify(title)).toBe(false);
    expect(ok(0, { id: "century", title: "Curaçao \u{1F6E9}" }).success).toBe(true);
    expect(ok(0, { id: "century", criteria: "x".repeat(2001) }).success).toBe(false);
  });

  it("draftVersion is a required non-negative integer", () => {
    for (const v of [undefined, -1, 1.5, "1", null]) expect(awards.safeParse({ draftVersion: v, awards: [{ id: "century", title: "a" }] }).success, String(v)).toBe(false);
    expect(versionOnlyRequest.safeParse({ draftVersion: 0 }).success).toBe(true);
    expect(versionOnlyRequest.safeParse({ draftVersion: 0, extra: 1 }).success).toBe(false);
    expect(publishRequest.safeParse({ draftVersion: 2, note: "why" }).success).toBe(true);
    expect(publishRequest.safeParse({ draftVersion: 2, note: "x".repeat(301) }).success).toBe(false);
    expect(publishRequest.safeParse({ draftVersion: 2, actor: "me" }).success).toBe(false);
  });
});

describe("clipper-cards and aircraft-tags edit requests", () => {
  it("names are 1-500 characters, one per Card, at most 25", () => {
    const cards = EDIT_REQUESTS["clipper-cards"];
    expect(cards.safeParse({ draftVersion: 0, names: [{ key: "787", name: "Boeing 787" }] }).success).toBe(true);
    expect(cards.safeParse({ draftVersion: 0, names: [{ key: "787", name: "" }] }).success).toBe(false);
    expect(cards.safeParse({ draftVersion: 0, names: [{ key: "787", name: "n".repeat(501) }] }).success).toBe(false);
    expect(cards.safeParse({ draftVersion: 0, names: [{ key: "787", name: "a" }, { key: "787", name: "b" }] }).success).toBe(false);
    expect(cards.safeParse({ draftVersion: 0, names: Array.from({ length: 26 }, (_, i) => ({ key: `k${i}`, name: "n" })) }).success).toBe(false);
    expect(cards.safeParse({ draftVersion: 0, names: [{ key: "787", name: "a", itemIds: [] }] }).success).toBe(false);
  });

  it("tags are from the seven, each once; an empty list clears", () => {
    const tags = EDIT_REQUESTS["aircraft-tags"];
    expect(tags.safeParse({ draftVersion: 0, entries: [{ cardKey: "787", tags: ["heavy", "vtol"] }] }).success).toBe(true);
    expect(tags.safeParse({ draftVersion: 0, entries: [{ cardKey: "787", tags: [] }] }).success).toBe(true);
    expect(tags.safeParse({ draftVersion: 0, entries: [{ cardKey: "787", tags: ["heavy", "heavy"] }] }).success).toBe(false);
    expect(tags.safeParse({ draftVersion: 0, entries: [{ cardKey: "787", tags: ["jumbo"] }] }).success).toBe(false);
    expect(tags.safeParse({ draftVersion: 0, entries: [{ cardKey: "787", tags: [], manufacturer: "Boeing" }] }).success).toBe(false);
  });
});

describe("the stored overlay is validated again on every read", () => {
  it("accepts what the API writes and refuses anything a hand edit could add", () => {
    expect(parseStoredEdits("field-awards", { awards: { century: { title: "x", target: 3 } } })).toEqual({ awards: { century: { title: "x", target: 3 } } });
    expect(parseStoredEdits("field-awards", {})).toEqual({});
    for (const bad of [{ awards: { century: { target: 0 } } }, { awards: { century: { metric: "x" } } }, { awards: { nope: { title: "x" } } }, { other: 1 }]) {
      expect(() => parseStoredEdits("field-awards", bad), JSON.stringify(bad)).toThrow();
    }
    expect(() => parseStoredEdits("aircraft-tags", { tags: { "787": ["bogus"] } })).toThrow();
    expect(() => parseStoredEdits("clipper-cards", { names: { "787": "" } })).toThrow();
  });
});

describe("merging and applying", () => {
  it("a later value for the same award field wins; other fields of the award stay", () => {
    const first = mergeEdits("field-awards", {}, awards.parse({ draftVersion: 0, awards: [{ id: "century", title: "One", target: 5 }] }));
    const second = mergeEdits("field-awards", first, awards.parse({ draftVersion: 1, awards: [{ id: "century", title: "Two" }, { id: "sharp-eyes", hidden: true }] }));
    expect(second).toEqual({ awards: { century: { title: "Two", target: 5 }, "sharp-eyes": { hidden: true } } });
  });

  it("applies fields to a copy and never touches id, metric or the sheet text; the base is not mutated", () => {
    const base = buildFieldAwardsBody(1);
    const before = JSON.stringify(base);
    const out = applyFieldAwardEdits(base, { awards: { century: { title: "T", criteria: "C", target: 7, hidden: true } } }) as { awards: Record<string, unknown>[] };
    expect(JSON.stringify(base)).toBe(before);
    const award = out.awards.find((a) => a["id"] === "century")!;
    const was = (base as { awards: Record<string, unknown>[] }).awards.find((a) => a["id"] === "century")!;
    expect(award).toEqual({ ...was, title: "T", criteria: "C", target: 7, hidden: true });
    expect(() => validateDocument("field-awards", { ...out, version: 1 }, 1)).not.toThrow();
  });

  it("tags: a kept tag keeps its source, a new one is provisional, the same set leaves the entry alone, a new Card is appended sorted", () => {
    const base = buildAircraftTagsBody(1) as { entries: { cardKey: string; tags: { tag: string; source: string }[] }[] };
    const tagged = base.entries.find((e) => e.tags.length > 0)!;
    const keep = tagged.tags[0]!;
    const added = keep.tag === "piston" ? "vtol" : "piston";
    const out = applyTagEdits(base, { tags: { [tagged.cardKey]: [keep.tag as never, added as never], "zz-new": ["heavy"], "aa-new": [] } }) as typeof base;
    const entry = out.entries.find((e) => e.cardKey === tagged.cardKey)!;
    expect(entry.tags).toEqual([keep, { tag: added, source: "provisional" }]);
    expect(out.entries.slice(-2).map((e) => e.cardKey)).toEqual(["aa-new", "zz-new"]);
    expect(out.entries.at(-1)).toEqual({ cardKey: "zz-new", manufacturer: null, manufacturerSource: null, tags: [{ tag: "heavy", source: "provisional" }] });
    const same = applyTagEdits(base, { tags: { [tagged.cardKey]: [...tagged.tags].reverse().map((t) => t.tag as never) } }) as typeof base;
    expect(same).toEqual(base);
    expect(() => validateDocument("aircraft-tags", { ...out, version: 1 }, 1)).not.toThrow();
  });

  it("card names: the overlay beats the published name, which beats the content's", () => {
    const derived = buildClipperCardsBody(2, [{ id: "mil-a1", answer: "Content Name", cardKey: "mil:content name" }, { id: "mil-a2", answer: "Other", cardKey: "mil:other" }]);
    const published = buildClipperCardsBody(1, [{ id: "mil-a1", answer: "Published Name", cardKey: "mil:content name" }]);
    const named = applyCardNames(derived, published, { names: { "mil:other": "Staff Name" } }) as { cards: { key: string; name: string }[] };
    expect(named.cards.find((c) => c.key === "mil:content name")?.name).toBe("Published Name");
    expect(named.cards.find((c) => c.key === "mil:other")?.name).toBe("Staff Name");
    expect(applyCardNames(derived, undefined, {}) as unknown).toEqual(derived);
  });

  it("sameContent ignores only the version", () => {
    const a = buildFieldAwardsBody(1);
    expect(sameContent({ ...a, version: 9 }, a)).toBe(true);
    expect(sameContent(applyFieldAwardEdits(a, { awards: { century: { target: 3 } } }), a)).toBe(false);
  });
});

describe("describing a change", () => {
  it("lists award fields that differ, in document order, with from and to", () => {
    const base = buildFieldAwardsBody(1);
    const after = applyFieldAwardEdits(base, { awards: { century: { target: 3 }, "first-flight": { hidden: true } } });
    expect(describeChanges("field-awards", base, after)).toEqual([
      { kind: "award", key: "first-flight", field: "hidden", from: false, to: true },
      { kind: "award", key: "century", field: "target", from: expect.any(Number), to: 3 },
    ]);
    expect(describeChanges("field-awards", base, base)).toEqual([]);
  });

  it("clipper-cards: added, removed, renamed and re-itemised; with no published document every Card is added", () => {
    const one = buildClipperCardsBody(1, [{ id: "mil-a1", answer: "A", cardKey: "mil:a" }, { id: "mil-a2", answer: "B", cardKey: "mil:b" }]);
    const two = buildClipperCardsBody(2, [{ id: "mil-a1", answer: "A2", cardKey: "mil:a" }, { id: "mil-a3", answer: "A", cardKey: "mil:a" }, { id: "mil-a4", answer: "C", cardKey: "mil:c" }]);
    const named = applyCardNames(two, one, { names: { "mil:a": "A renamed" } });
    expect(describeChanges("clipper-cards", one, named)).toEqual([
      { kind: "card-renamed", key: "mil:a", field: "name", from: "A", to: "A renamed" },
      { kind: "card-items", key: "mil:a", field: "itemIds", from: ["mil-a1"], to: ["mil-a1", "mil-a3"] },
      { kind: "card-added", key: "mil:c", to: "C" },
      { kind: "card-removed", key: "mil:b", from: "B" },
    ]);
    expect(describeChanges("clipper-cards", undefined, one).every((c) => c.kind === "card-added")).toBe(true);
  });

  it("aircraft-tags: only a changed tag set is a change", () => {
    const base = buildAircraftTagsBody(1);
    const after = applyTagEdits(base, { tags: { "new-card": ["heavy"] } });
    expect(describeChanges("aircraft-tags", base, after)).toEqual([{ kind: "tags", key: "new-card", from: [], to: ["heavy"] }]);
  });
});

describe("client tags, history and acknowledgements", () => {
  const base = {
    entries: [{ cardKey: "k", manufacturer: null, manufacturerSource: null, tags: [{ tag: "heavy", source: "client_ruling" }, { tag: "vtol", source: "provisional" }] }],
  };
  it("flags the removal of a non-provisional tag unless acknowledged, per Card", () => {
    expect(unacknowledgedClientRemovals(base, { tags: { k: ["vtol"] } })).toEqual([{ key: "k", tags: ["heavy"] }]);
    expect(unacknowledgedClientRemovals(base, { tags: { k: ["vtol"] }, ackClientTagRemoval: { k: true } })).toEqual([]);
    expect(unacknowledgedClientRemovals(base, { tags: { k: ["heavy"] } })).toEqual([]); // dropping a provisional tag is free
    expect(unacknowledgedClientRemovals(base, { tags: { other: [] } })).toEqual([]);
  });

  it("an acknowledgement belongs to one edit: a later edit of the Card without it clears it", () => {
    const tags = EDIT_REQUESTS["aircraft-tags"];
    const first = mergeEdits("aircraft-tags", {}, tags.parse({ draftVersion: 0, entries: [{ cardKey: "k", tags: [], acknowledgeClientTagRemoval: true }] }));
    expect(first.ackClientTagRemoval).toEqual({ k: true });
    const second = mergeEdits("aircraft-tags", first, tags.parse({ draftVersion: 1, entries: [{ cardKey: "k", tags: ["vtol"] }] }));
    expect(second.ackClientTagRemoval).toEqual({});
    expect(tags.safeParse({ draftVersion: 0, entries: [{ cardKey: "k", tags: [], acknowledgeClientTagRemoval: false }] }).success).toBe(false);
  });

  it("history keeps order, survives merges, lists editors once and is salvaged from an invalid overlay", () => {
    const at = new Date("2026-11-02T10:00:00Z");
    let e = withHistory({}, "a", "edit", 1, at);
    e = withHistory(mergeEdits("field-awards", e, awards.parse({ draftVersion: 1, awards: [{ id: "century", title: "x" }] })), "b", "edit", 2, at);
    e = withHistory(e, "a", "discard", 3, at);
    expect(e.history?.map((h) => [h.principal, h.action])).toEqual([["a", "edit"], ["b", "edit"], ["a", "discard"]]);
    expect(editorsOf(e)).toEqual(["a", "b"]);
    expect(e.awards?.["century"]).toEqual({ title: "x" });
    expect(salvageHistory({ awards: { century: { target: 0 } }, history: e.history })).toEqual(e.history);
    expect(salvageHistory({ history: [{ nope: 1 }] })).toEqual([]);
    expect(salvageHistory(null)).toEqual([]);
    expect(parseStoredEdits("field-awards", { history: e.history })).toEqual({ history: e.history });
  });

  it("describeChanges records the removed client tags and whether they were acknowledged", () => {
    const after = applyTagEdits(base, { tags: { k: ["vtol"] } });
    expect(describeChanges("aircraft-tags", base, after, {})).toEqual([{ kind: "tags", key: "k", from: ["heavy", "vtol"], to: ["vtol"], removedClientTags: ["heavy"] }]);
    expect(describeChanges("aircraft-tags", base, after, { ackClientTagRemoval: { k: true } })[0]).toMatchObject({ acknowledgedRemoval: true });
  });

  it("the publish request accepts acknowledgeCardRemoval only as true", () => {
    expect(publishRequest.safeParse({ draftVersion: 1, acknowledgeCardRemoval: true }).success).toBe(true);
    expect(publishRequest.safeParse({ draftVersion: 1, acknowledgeCardRemoval: false }).success).toBe(false);
  });
});

describe("codes and audit actions", () => {
  it("the three new error codes exist and content_publish is an audit action", () => {
    for (const code of ["version_conflict", "nothing_to_publish", "content_invalid"]) expect(ERROR_CODES).toContain(code);
    expect(ADMIN_AUDIT_ACTIONS).toEqual([
      "content_import",
      "content_publish",
      "content_edit",
      "content_retire",
      "content_restore",
      "role_request",
      "role_approve",
      "role_reject",
      "role_grant",
      "role_revoke",
      "role_block",
      "role_unblock",
      "role_email_edit",
      "media_upload",
      "media_version",
      "media_edit",
      "media_publish",
      "media_withdraw",
      "content_media_link",
    ]);
  });
});

describe("only draft-store.ts writes content_drafts, and only the publish path writes content_publish audit rows", () => {
  const SRC = join(import.meta.dirname, "..", "src");
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
    });
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const WRITE = /\.\s*(?:insert|update|delete)\s*\(\s*(?:schema\s*\.\s*)?contentDrafts\b|\b(?:insert\s+into|update|delete\s+from|truncate(?:\s+table)?)\s+(?:only\s+)?(?:public\s*\.\s*)?"?content_drafts\b/i;
  const ALLOWED = join("content", "documents", "draft-store.ts");
  const PUBLISH_AUDIT = /["']content_publish["']/;

  it("no other source file inserts, updates or deletes it", () => {
    const offenders = files(SRC)
      .filter((f) => !f.endsWith(ALLOWED))
      .filter((f) => WRITE.test(strip(readFileSync(f, "utf8"))))
      .map((f) => relative(SRC, f).split(sep).join("/"));
    expect(offenders).toEqual([]);
    expect(WRITE.test(strip(readFileSync(join(SRC, ALLOWED), "utf8")))).toBe(true); // not vacuous
  });

  it("the checker catches seeded violations", () => {
    for (const code of ["db.update(contentDrafts).set({})", "tx.delete(contentDrafts)", "sql`UPDATE content_drafts SET edits = '{}'`", 'sql`DELETE FROM "content_drafts"`']) {
      expect(WRITE.test(code), code).toBe(true);
    }
    expect(WRITE.test("db.select().from(contentDrafts)")).toBe(false);
  });

  it("the publish audit action is written in exactly one service, next to the document insert", () => {
    const writers = files(SRC)
      .filter((f) => PUBLISH_AUDIT.test(strip(readFileSync(f, "utf8"))))
      .map((f) => relative(SRC, f).split(sep).join("/"))
      .sort();
    // enums.ts holds the list; the service writes the row.
    expect(writers).toEqual(["content/documents/content-admin.service.ts", "db/enums.ts", "db/schema.ts"]);
  });
});
