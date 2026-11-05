import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { RANKS } from "../src/rules/ranks.js";
import type { Rank } from "../src/rules/ranks.js";
import {
  EMPTY_POINTER,
  NOTHING_TO_RESTORE_MESSAGE,
  NOT_UPLOADED_MESSAGE,
  POINTER_CHANGED_MESSAGE,
  SAME_AS_CURRENT_MESSAGE,
  activationGuardErrors,
  cleanNote,
  coverageErrors,
  ownRankCounts,
  planActivate,
  planRestore,
  pointerBody,
  pointerOf,
  readinessErrors,
  releaseBasis,
  releaseCardKey,
  releaseCoverage,
  restoreGuardErrors,
  selectionErrors,
  uploadBody,
} from "../src/content/releases/release-rules.js";
import type { FrozenItem, MediaFact, Pointer, ReleaseItemRow } from "../src/content/releases/release-rules.js";

// Wave W3, commit 2 (docs/plans/website-content.md 3.3 and 3.4): the pure rules of Military releases.

const item = (n: number, over: Partial<ReleaseItemRow> = {}): ReleaseItemRow => ({
  id: `mil-a${n}`,
  rank: RANKS[(n - 1) % 5] as string,
  status: "approved",
  version: 3,
  data: { answer: `Aircraft ${n}`, wrong: [`W${n}a`, `W${n}b`, `W${n}c`], sourceFile: `f${n}.jpg`, photographer: "P" },
  cardKey: null,
  prepStage: "approved",
  prepVersion: 3,
  mediaId: n,
  ...over,
});
const fact = (n: number, over: Partial<MediaFact> = {}): MediaFact => ({
  id: n,
  state: "published",
  publishedVersion: 1,
  ownerIsDemo: false,
  sha256: `${n}`.padStart(64, "a"),
  credit: "Credit",
  ...over,
});
const facts = (...list: MediaFact[]) => new Map(list.map((f) => [f.id, f]));
const frozen = (n: number, over: Partial<FrozenItem> = {}): FrozenItem => ({ itemId: `mil-a${n}`, itemVersion: 3, mediaId: n, mediaVersion: 1, photoSha256: `${n}`.padStart(64, "a"), ...over });

describe("releaseBasis (port of the website's releaseBasis over a selection)", () => {
  it("is the sorted <id>:<version> list joined by commas, whatever the input order", () => {
    expect(releaseBasis([{ id: "mil-a2", version: 5 }, { id: "mil-a1", version: 3 }])).toBe("mil-a1:3,mil-a2:5");
    expect(releaseBasis([{ id: "mil-a1", version: 3 }, { id: "mil-a2", version: 5 }])).toBe("mil-a1:3,mil-a2:5");
  });
  it("sorts as plain strings, exactly like the website (mil-a10 before mil-a2)", () => {
    expect(releaseBasis([{ id: "mil-a2", version: 1 }, { id: "mil-a10", version: 1 }])).toBe("mil-a10:1,mil-a2:1");
  });
  it("a different selection or version gives a different basis; an empty selection is empty", () => {
    expect(releaseBasis([{ id: "mil-a1", version: 3 }])).not.toBe(releaseBasis([{ id: "mil-a1", version: 4 }]));
    expect(releaseBasis([{ id: "mil-a1", version: 3 }])).not.toBe(releaseBasis([{ id: "mil-a1", version: 3 }, { id: "mil-a2", version: 1 }]));
    expect(releaseBasis([])).toBe("");
  });
});

describe("request schemas are strict", () => {
  const ok = { itemIds: ["mil-a1"], basis: "mil-a1:1", previewed: true };
  it("upload accepts the documented body and refuses extra keys, empty or oversized lists and a missing flag", () => {
    expect(uploadBody.safeParse(ok).success).toBe(true);
    expect(uploadBody.safeParse({ ...ok, note: "n" }).success).toBe(true);
    expect(uploadBody.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(uploadBody.safeParse({ ...ok, itemIds: [] }).success).toBe(false);
    expect(uploadBody.safeParse({ ...ok, itemIds: Array.from({ length: 2001 }, (_, i) => `mil-a${i + 1}`) }).success).toBe(false);
    expect(uploadBody.safeParse({ ...ok, itemIds: ["x".repeat(65)] }).success).toBe(false);
    expect(uploadBody.safeParse({ itemIds: ok.itemIds, basis: ok.basis }).success).toBe(false);
    expect(uploadBody.safeParse({ ...ok, note: "x".repeat(501) }).success).toBe(false);
  });
  it("a previewed value that is not true passes the schema (the rules refuse it with 422)", () => {
    expect(uploadBody.safeParse({ ...ok, previewed: false }).success).toBe(true);
  });
  it("activate and restore take expectedPointerVersion (0 or more) and an optional note, nothing else", () => {
    expect(pointerBody.safeParse({ expectedPointerVersion: 0 }).success).toBe(true);
    expect(pointerBody.safeParse({ expectedPointerVersion: 3, note: "x" }).success).toBe(true);
    expect(pointerBody.safeParse({ expectedPointerVersion: -1 }).success).toBe(false);
    expect(pointerBody.safeParse({ expectedPointerVersion: 1.5 }).success).toBe(false);
    expect(pointerBody.safeParse({}).success).toBe(false);
    expect(pointerBody.safeParse({ expectedPointerVersion: 0, release: 1 }).success).toBe(false);
  });
  it("a blank note is stored as null; others are trimmed", () => {
    expect(cleanNote(undefined)).toBeNull();
    expect(cleanNote("   ")).toBeNull();
    expect(cleanNote("  hi ")).toBe("hi");
  });
});

describe("the pointer stack", () => {
  const at = (current: number | null, history: number[], version: number): Pointer => ({ current, history, version });
  const uploaded = (version: number, basis = `b${version}`) => ({ version, basis, status: "uploaded" as const });

  it("no activation row is nothing current at version 0; the newest row is the pointer", () => {
    expect(pointerOf(undefined)).toEqual(EMPTY_POINTER);
    expect(pointerOf({ sequence: 3, releaseVersion: 2, history: [1] })).toEqual(at(2, [1], 3));
  });

  it("the first activation pushes nothing; each later one pushes the previous current", () => {
    const first = planActivate(EMPTY_POINTER, 0, uploaded(1), undefined);
    expect(first).toEqual({ next: at(1, [], 1) });
    const second = planActivate(at(1, [], 1), 1, uploaded(2), "b1");
    expect(second).toEqual({ next: at(2, [1], 2) });
    const third = planActivate(at(2, [1], 2), 2, uploaded(3), "b2");
    expect(third).toEqual({ next: at(3, [1, 2], 3) });
  });

  it("restore pops the stack (and the version still goes up)", () => {
    expect(planRestore(at(3, [1, 2], 3), 3)).toEqual({ next: at(2, [1], 4) });
    expect(planRestore(at(2, [1], 4), 4)).toEqual({ next: at(1, [], 5) });
  });

  it("activate refusals: stale pointer 409, unknown release 404, released 422, same basis 409 nothing_to_publish", () => {
    expect(planActivate(at(1, [], 1), 0, uploaded(2), "b1")).toEqual({ refusal: { status: 409, code: "version_conflict", message: POINTER_CHANGED_MESSAGE } });
    expect(planActivate(at(1, [], 1), 1, undefined, "b1")).toMatchObject({ refusal: { status: 404, code: "not_found" } });
    expect(planActivate(at(2, [1], 2), 2, { version: 1, basis: "b1", status: "released" }, "b2")).toEqual({ refusal: { status: 422, code: "content_invalid", message: NOT_UPLOADED_MESSAGE } });
    expect(planActivate(at(1, [], 1), 1, uploaded(2, "b1"), "b1")).toEqual({ refusal: { status: 409, code: "nothing_to_publish", message: SAME_AS_CURRENT_MESSAGE } });
  });

  it("ASSUMPTION: the pointer is checked first, so a stale caller learns the pointer moved before anything about the release", () => {
    expect(planActivate(at(1, [], 1), 0, undefined, "b1")).toMatchObject({ refusal: { code: "version_conflict" } });
  });

  it("the same basis as an OLDER release (not the current one) is allowed", () => {
    expect(planActivate(at(2, [1], 2), 2, uploaded(3, "b1"), "b2")).toEqual({ next: at(3, [1, 2], 3) });
  });

  it("restore refusals: stale pointer 409, empty history 422", () => {
    expect(planRestore(at(1, [], 1), 0)).toMatchObject({ refusal: { status: 409, code: "version_conflict" } });
    expect(planRestore(at(1, [], 1), 1)).toEqual({ refusal: { status: 422, code: "content_invalid", message: NOTHING_TO_RESTORE_MESSAGE } });
    expect(planRestore(EMPTY_POINTER, 0)).toMatchObject({ refusal: { status: 422 } });
  });

  it("the input pointer is never modified", () => {
    const p = at(2, [1], 2);
    planActivate(p, 2, uploaded(3, "x"), "b2");
    planRestore(p, 2);
    expect(p).toEqual(at(2, [1], 2));
  });
});

describe("selection errors", () => {
  const rows = new Map([item(1), item(2), item(3, { status: "retired" })].map((r) => [r.id, r]));
  it("a repeated id, an unknown id and a retired item are reported", () => {
    expect(selectionErrors(["mil-a1", "mil-a2"], rows)).toEqual({ unknown: [], errors: [] });
    expect(selectionErrors(["mil-a1", "mil-a1"], rows).errors).toEqual(["Each item may be chosen once: mil-a1 repeated."]);
    expect(selectionErrors(["mil-a1", "mil-a9"], rows)).toEqual({ unknown: ["mil-a9"], errors: [] });
    expect(selectionErrors(["mil-a3"], rows).errors).toEqual(["mil-a3: the item is retired. Restore it or leave it out."]);
  });
});

describe("readiness errors (every reason at once)", () => {
  const good = [item(1), item(2)];
  const published = facts(fact(1), fact(2));
  it("approved, current, published, distinct photos: no errors", () => {
    expect(readinessErrors(good, published)).toEqual([]);
  });
  it("a package below approved, and a stale approved one (version moved past prep_version), are refused", () => {
    expect(readinessErrors([item(1, { prepStage: "previewed" })], published)).toEqual(["mil-a1: the package is not approved (it is at previewed)."]);
    expect(readinessErrors([item(1, { prepStage: null, prepVersion: null })], published)).toEqual(["mil-a1: the package is not approved (it is at no stage)."]);
    expect(readinessErrors([item(1, { version: 4 })], published)).toEqual(["mil-a1: the package changed after approval. Step it back to Previewed and approve it again."]);
  });
  it("a missing photo link is refused whatever the photo source (licensed evidence does not replace a stored photo)", () => {
    expect(readinessErrors([item(1, { mediaId: null })], published)).toEqual(["mil-a1: link a published photo. A release needs a stored photograph for every item."]);
  });
  it("an unknown, unpublished, withdrawn or demo-owned photo is refused", () => {
    expect(readinessErrors([item(1)], facts())).toEqual(["mil-a1: the linked photo med-1 does not exist."]);
    expect(readinessErrors([item(1)], facts(fact(1, { state: "unverified", publishedVersion: null, sha256: null })))).toEqual(["mil-a1: the linked photo med-1 is not published."]);
    expect(readinessErrors([item(1)], facts(fact(1, { state: "withdrawn", publishedVersion: null, sha256: null })))).toEqual(["mil-a1: the linked photo med-1 is not published."]);
    expect(readinessErrors([item(1)], facts(fact(1, { ownerIsDemo: true })))).toEqual(["mil-a1: the linked photo med-1 belongs to the shared demo account and cannot be used."]);
  });
  it("two items sharing one photo hash are refused, naming the first", () => {
    const same = "c".repeat(64);
    expect(readinessErrors(good, facts(fact(1, { sha256: same }), fact(2, { sha256: same })))).toEqual(["mil-a2: uses the same photograph as mil-a1."]);
  });
  it("reasons from several items are all listed", () => {
    const errors = readinessErrors([item(1, { prepStage: "content_prepared" }), item(2, { mediaId: null })], published);
    expect(errors).toHaveLength(2);
  });
});

describe("coverage uses the backend dealer", () => {
  const ranked = (n: number, rank: Rank): ReleaseItemRow => item(n, { rank });

  it("ASSUMPTION: Military release coverage uses nearest-ranks (C13 open)", () => {
    // Ten questions, all Chief Pilot. nearest-ranks deals them at every rank; the website's lower-ranks rule would deal none at Trainee.
    const pool = Array.from({ length: 10 }, (_, i) => ranked(i + 1, "chief-pilot"));
    const { perRank, unusable } = releaseCoverage(pool);
    expect(unusable).toEqual([]);
    for (const rank of RANKS) expect(perRank[rank], rank).toBe(10);
    expect(coverageErrors({ perRank, unusable })).toEqual([]);
  });

  it("a thin pool names every rank that cannot fill a Trip, with its count", () => {
    const pool = Array.from({ length: 4 }, (_, i) => ranked(i + 1, "captain"));
    const errors = coverageErrors(releaseCoverage(pool));
    expect(errors).toHaveLength(5);
    expect(errors[0]).toBe("trainee: a Trip would hold 4 of 10 Flights; add more approved questions.");
  });

  it("an item whose stored question is unusable is named and left out of the pool", () => {
    const broken = item(11, { rank: "captain", data: { answer: "x", wrong: ["only one"], sourceFile: "f.jpg" } });
    const pool = [...Array.from({ length: 10 }, (_, i) => ranked(i + 1, "captain")), broken];
    const result = releaseCoverage(pool);
    expect(result.unusable).toEqual(["mil-a11"]);
    expect(coverageErrors(result)).toEqual(["mil-a11: the stored question is not usable (an answer and three wrong answers are needed)."]);
  });

  it("an item with a blank source file is named, not silently dropped from coverage", () => {
    const blank = item(11, { rank: "captain", data: { answer: "x", wrong: ["a", "b", "c"], sourceFile: "  ", photographer: "P" } });
    const pool = [...Array.from({ length: 10 }, (_, i) => ranked(i + 1, "captain")), blank];
    const result = releaseCoverage(pool);
    expect(result.noSource).toEqual(["mil-a11"]);
    expect(result.unusable).toEqual([]);
    expect(coverageErrors(result)).toEqual(["mil-a11: the stored question has no source file."]);
  });

  it("ownRankCounts counts approved, current, non-retired packages per rank (non-blocking)", () => {
    const counts = ownRankCounts([
      item(1, { rank: "trainee" }),
      item(2, { rank: "trainee" }),
      item(3, { rank: "trainee", prepStage: "previewed" }),
      item(4, { rank: "trainee", version: 9 }),
      item(5, { rank: "trainee", status: "retired" }),
      item(6, { rank: "captain" }),
      item(7, { rank: "captain", prepStage: null, prepVersion: null }),
    ]);
    expect(counts).toEqual({ trainee: 2, "first-officer": 0, captain: 1, "check-airman": 0, "chief-pilot": 0 });
  });
});

describe("Card key freeze", () => {
  it("keeps the item's own key; derives one from the stored answer when there is none; null for a blank key", () => {
    expect(releaseCardKey({ cardKey: "kept", data: { answer: "Other" } })).toBe("kept");
    expect(releaseCardKey({ cardKey: null, data: { answer: "Boeing B-52H Stratofortress" } })).toBeTruthy();
    expect(releaseCardKey({ cardKey: null, data: { answer: "   " } })).toBeNull();
    expect(releaseCardKey({ cardKey: null, data: null })).toBeNull();
  });
});

describe("activation guard, each leg separately", () => {
  const items = [frozen(1), frozen(2)];
  const current = (over: Record<string, { status: string; version: number }> = {}) =>
    new Map<string, { status: string; version: number }>([["mil-a1", { status: "approved", version: 3 }], ["mil-a2", { status: "approved", version: 3 }], ...Object.entries(over)]);
  const live = facts(fact(1), fact(2));

  it("nothing changed: no errors", () => {
    expect(activationGuardErrors(items, current(), live)).toEqual([]);
  });
  it("(a) a retired item and a missing item", () => {
    expect(activationGuardErrors(items, current({ "mil-a1": { status: "retired", version: 4 } }), live)).toEqual(["mil-a1: the item is retired or no longer stored."]);
    const missing = current();
    missing.delete("mil-a2");
    expect(activationGuardErrors(items, missing, live)).toEqual(["mil-a2: the item is retired or no longer stored."]);
  });
  it("(b) a changed item version", () => {
    expect(activationGuardErrors(items, current({ "mil-a2": { status: "approved", version: 4 } }), live)).toEqual(["mil-a2: the item changed since the upload (version 3, now 4)."]);
  });
  it("(c) a photo no longer published, republished at another version, or with another hash", () => {
    expect(activationGuardErrors(items, current(), facts(fact(1, { state: "withdrawn", publishedVersion: null, sha256: null }), fact(2)))).toEqual(["mil-a1: photo med-1 is no longer published."]);
    expect(activationGuardErrors(items, current(), facts(fact(1), fact(2, { publishedVersion: 2 })))).toEqual(["mil-a2: photo med-2 was republished (version 2, the release froze version 1)."]);
    expect(activationGuardErrors(items, current(), facts(fact(1, { sha256: "d".repeat(64) }), fact(2)))).toEqual(["mil-a1: photo med-1 no longer matches the file the release froze."]);
    expect(activationGuardErrors(items, current(), facts(fact(1)))).toEqual(["mil-a2: photo med-2 is no longer published."]);
  });
  it("ASSUMPTION: the media revision is not part of the guard (a draft-only edit leaves the published file and credit untouched)", () => {
    // MediaFact carries no revision at all: the guard cannot compare it, and a changed credit or note on the draft changes nothing here.
    expect(Object.keys(fact(1))).not.toContain("revision");
    expect(activationGuardErrors(items, current(), facts(fact(1, { credit: "Another credit" }), fact(2)))).toEqual([]);
  });
  it("every change is listed at once", () => {
    const errors = activationGuardErrors(items, current({ "mil-a1": { status: "approved", version: 9 } }), facts(fact(1), fact(2, { state: "withdrawn", publishedVersion: null, sha256: null })));
    expect(errors).toHaveLength(2);
  });
  it("restore checks only the photos (an item change does not block a restore)", () => {
    expect(restoreGuardErrors(items, live)).toEqual([]);
    expect(restoreGuardErrors(items, facts(fact(1), fact(2, { state: "withdrawn", publishedVersion: null, sha256: null })))).toEqual(["mil-a2: photo med-2 is no longer published."]);
  });
});

// docs/plans/website-content.md 3.1: release-store.ts is the only writer of the three release tables. The patterns run over each source
// file with comments removed, so a mention in prose does not count; a Drizzle write or a raw SQL write both do.
describe("only release-store.ts writes the three release tables (source scan)", () => {
  const SRC = join(import.meta.dirname, "..", "src");
  const ALLOWED = join("content", "releases", "release-store.ts");
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
    });
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const TABLES = "(?:contentReleases|contentReleaseItems|contentReleaseActivations)";
  const SNAKE = "(?:content_releases|content_release_items|content_release_activations)";
  const WRITE = new RegExp(
    String.raw`\.\s*(?:insert|update|delete)\s*\(\s*(?:schema\s*\.\s*)?${TABLES}\b|\b(?:insert\s+into|update|delete\s+from|truncate(?:\s+table)?)\s+(?:only\s+)?(?:public\s*\.\s*)?"?${SNAKE}\b`,
    "i",
  );

  it("the pattern matches Drizzle and raw SQL writes and ignores reads", () => {
    for (const text of ["tx.insert(contentReleases).values(x)", "db.update( contentReleaseItems )", "tx.delete(schema.contentReleaseActivations)", 'INSERT INTO "content_releases"', "delete from content_release_items", "TRUNCATE content_release_activations"]) {
      expect(WRITE.test(text), text).toBe(true);
    }
    for (const text of ["tx.select().from(contentReleases)", "// tx.insert(contentReleases)", "SELECT * FROM content_releases"]) {
      expect(WRITE.test(strip(text)), text).toBe(false);
    }
  });

  it("the store itself does write (the scan is not vacuous)", () => {
    expect(WRITE.test(strip(readFileSync(join(SRC, ALLOWED), "utf8")))).toBe(true);
  });

  it("no other source file writes them", () => {
    const offenders = files(SRC)
      .filter((f) => !f.endsWith(ALLOWED))
      .filter((f) => WRITE.test(strip(readFileSync(f, "utf8"))))
      .map((f) => relative(SRC, f).split(sep).join("/"));
    expect(offenders).toEqual([]);
  });
});
