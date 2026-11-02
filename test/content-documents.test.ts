import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { CanonicalJsonError, canonicalBytes, canonicalJson, sha256Hex } from "../src/content/documents/canonical.js";
import { DOCUMENT_CACHE_CONTROL, MANIFEST_CACHE_CONTROL, ifNoneMatchHits } from "../src/content/documents/content-documents.controller.js";
import {
  DOCUMENT_FORMAT,
  DocumentValidationError,
  buildAircraftTagsBody,
  buildClipperCardsBody,
  buildFieldAwardsBody,
  isDocumentName,
  parseAircraftTags,
  parseClipperCards,
  parseFieldAwards,
  validateDocument,
} from "../src/content/documents/documents.js";
import { EMPTY_GENERATED_AT, buildManifest, manifestModules } from "../src/content/documents/manifest.js";
import type { DocumentMeta } from "../src/content/documents/document-store.js";
import { CONTENT_DOCUMENT_NAMES } from "../src/db/enums.js";
import { SEED_AIRCRAFT_TAG_ENTRIES, SEED_AIRCRAFT_TAG_TABLE, SEED_COMMERCIAL_CARD_KEYS } from "../src/rules/aircraft-tags.js";
import { militaryCardKey } from "../src/rules/clipper-cards.js";
import { FIELD_AWARD_CATALOG } from "../src/rules/field-award-catalog.js";
import { FIELD_AWARD_IDS } from "../src/rules/field-awards.js";
import { MODULE_IDS } from "../src/rules/modules.js";

// Slice T4, pure parts: the canonical serialisation, the generated v1 documents and their validators, the manifest
// recipe, and the rule that only document-store.ts writes content_documents. The database parts are in
// content-documents.e2e.test.ts.

/** What jsonb does to a value: parses to the same data with arbitrary key order and whitespace lost. */
function throughJsonb(value: unknown): unknown {
  const shuffle = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(shuffle)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, shuffle(x)]))
        : v;
  return JSON.parse(JSON.stringify(shuffle(value), null, 4));
}

describe("canonical serialisation", () => {
  it("sorts keys at every depth, writes no whitespace and keeps array order", () => {
    expect(canonicalJson({ b: [3, { z: null, a: true }], a: "x" })).toBe('{"a":"x","b":[3,{"a":true,"z":null}]}');
  });

  it("is independent of key order and whitespace (what jsonb loses)", () => {
    const body = buildFieldAwardsBody(1);
    expect(canonicalJson(throughJsonb(body))).toBe(canonicalJson(body));
    expect(sha256Hex(canonicalBytes(throughJsonb(body)))).toBe(sha256Hex(canonicalBytes(body)));
  });

  it("is UTF-8 without a byte order mark or newline, and writes non-ASCII as is", () => {
    const bytes = canonicalBytes({ name: "Curaçao – \u{1F6E9}" });
    expect(bytes.toString("utf8")).toBe('{"name":"Curaçao – \u{1F6E9}"}');
    expect(bytes[0]).toBe(0x7b);
    expect(bytes[bytes.length - 1]).toBe(0x7d);
    expect(bytes.length).toBeGreaterThan('{"name":"Curaçao – "}'.length); // multi-byte characters counted in bytes
  });

  it("escapes with JSON.stringify's rules, sorts keys by UTF-16 code unit and ignores insertion order", () => {
    expect(canonicalJson({ "é": 1, a: 2, B: 3 })).toBe('{"B":3,"a":2,"é":1}');
    expect(canonicalJson({ q: 'a"b\\c\n\u0001' })).toBe('{"q":"a\\"b\\\\c\\n\\u0001"}');
  });

  it("matches a SHA-256 computed over the written bytes", () => {
    const value = { version: 1, entries: ["a", "b"] };
    expect(sha256Hex(canonicalBytes(value))).toBe(createHash("sha256").update('{"entries":["a","b"],"version":1}', "utf8").digest("hex"));
  });

  it("refuses what jsonb or UTF-8 could not round-trip, and fractions", () => {
    for (const bad of [1.5, Number.NaN, Infinity, -0, 2 ** 53, undefined, () => 1, 10n, new Date(0), "a\u0000b", "\ud800", { k: undefined }, { "\ud800": 1 }]) {
      expect(() => canonicalJson({ v: bad }), String(bad)).toThrow(CanonicalJsonError);
    }
    expect(() => canonicalJson(Object.create({ inherited: 1 }))).toThrow(CanonicalJsonError);
    expect(canonicalJson({ v: Number.MAX_SAFE_INTEGER })).toBe('{"v":9007199254740991}');
  });
});

describe("generated v1 documents", () => {
  it("field-awards: 28 awards on the Unity code ids, the sheet text verbatim, no `provisional` key", () => {
    const body = buildFieldAwardsBody(1) as { awards: Record<string, unknown>[]; source: unknown };
    expect(body.awards.map((a) => a["id"])).toEqual([...FIELD_AWARD_IDS]);
    expect(body.awards.every((a) => !("provisional" in a))).toBe(true);
    expect(body.source).toEqual({ file: "Field Awards #1.xlsx", sha256: "a41ae3b7a4d9a237c0aa4bb1919e77934484e61c511ccb641d053a7a0a76e593", importDate: "2026-10-28" });
    const parsed = parseFieldAwards(body, 1);
    expect(parsed.awards).toEqual(FIELD_AWARD_CATALOG); // incl. the derived `provisional` (the eight tag awards)
    expect(parsed.awards.filter((a) => a.provisional).map((a) => a.id)).toEqual(FIELD_AWARD_CATALOG.filter((a) => a.provisional).map((a) => a.id));
  });

  it("aircraft-tags: the seed table, entry for entry, with per-tag sources", () => {
    const parsed = parseAircraftTags(buildAircraftTagsBody(1), 1);
    expect([...parsed.tags.values()]).toEqual([...SEED_AIRCRAFT_TAG_TABLE.values()]);
    expect(parsed.tags.size).toBe(SEED_AIRCRAFT_TAG_ENTRIES.length);
  });

  // If one of these fails, a code constant behind a v1 seed changed. A fresh database would then seal different v1 bytes
  // than every existing database already holds. Do not just update the digest: publish the change as version 2 (T6).
  it("GOLDEN: the v1 seed bytes of field-awards and aircraft-tags", () => {
    const awards = canonicalBytes(buildFieldAwardsBody(1));
    const tags = canonicalBytes(buildAircraftTagsBody(1));
    expect({ awards: [awards.length, sha256Hex(awards)], tags: [tags.length, sha256Hex(tags)] }).toEqual({
      awards: [GOLDEN.awardsBytes, GOLDEN.awardsSha],
      tags: [GOLDEN.tagsBytes, GOLDEN.tagsSha],
    });
  });

  it("clipper-cards: commercial families first, then one Card per distinct Military key, named by the first item", () => {
    const items = [
      { id: "mil-a2", answer: "Eurofighter Typhoon", cardKey: militaryCardKey("Eurofighter Typhoon") },
      { id: "mil-a3", answer: "Boeing C-17 Globemaster III", cardKey: militaryCardKey("Boeing C-17 Globemaster III") },
      { id: "mil-a10", answer: "eurofighter  typhoon", cardKey: militaryCardKey("eurofighter  typhoon") },
    ];
    const body = buildClipperCardsBody(1, items) as { cards: { key: string; module: string; name: string; keySource: string; itemIds: string[] }[] };
    expect(body.cards.slice(0, SEED_COMMERCIAL_CARD_KEYS.size).map((c) => c.key)).toEqual([...SEED_COMMERCIAL_CARD_KEYS]);
    const commercial = body.cards[0];
    expect(commercial).toEqual({ key: "707", module: "identifier", name: "707", keySource: "unity_family", itemIds: [] });
    const military = body.cards.slice(SEED_COMMERCIAL_CARD_KEYS.size);
    expect(military).toEqual([
      { key: "mil:eurofighter typhoon", module: "aircraft-identifier-military", name: "Eurofighter Typhoon", keySource: "client_answer_text", itemIds: ["mil-a2", "mil-a10"] },
      { key: "mil:boeing c-17 globemaster iii", module: "aircraft-identifier-military", name: "Boeing C-17 Globemaster III", keySource: "client_answer_text", itemIds: ["mil-a3"] },
    ]);
    expect(parseClipperCards(body, 1).version).toBe(1);
    expect(isDocumentName("clipper-cards")).toBe(true);
  });

  it("names, formats and the DB list agree", () => {
    expect([...CONTENT_DOCUMENT_NAMES].sort()).toEqual(["aircraft-tags", "clipper-cards", "field-awards"]);
    for (const name of CONTENT_DOCUMENT_NAMES) expect(DOCUMENT_FORMAT[name]).toBe(`${name}.v1`);
    expect(isDocumentName("nope")).toBe(false);
  });
});

describe("document validation protects catalogInForce from a bad row", () => {
  const good = () => buildFieldAwardsBody(2) as { awards: Record<string, unknown>[]; [k: string]: unknown };
  const bad = (edit: (b: ReturnType<typeof good>) => void) => {
    const body = good();
    edit(body);
    return () => parseFieldAwards(body, 2);
  };

  it("accepts the generated body", () => {
    expect(() => parseFieldAwards(good(), 2)).not.toThrow();
  });

  it("rejects a body whose version is not the row's", () => {
    expect(() => parseFieldAwards(good(), 3)).toThrow(DocumentValidationError);
  });

  it("rejects a missing, duplicated or unknown award", () => {
    expect(bad((b) => b.awards.pop())).toThrow(DocumentValidationError);
    expect(bad((b) => { b.awards[1] = { ...b.awards[0]! }; })).toThrow(/appears twice/);
    expect(bad((b) => { b.awards[0] = { ...b.awards[0]!, id: "first-solo" }; })).toThrow(DocumentValidationError);
  });

  it("rejects a target that is 0, negative, fractional or absurd", () => {
    for (const target of [0, -1, 1.5, 2_000_000_000, "5", null]) {
      expect(bad((b) => { b.awards[1] = { ...b.awards[1]!, target }; }), String(target)).toThrow(DocumentValidationError);
    }
  });

  it("rejects an award whose metric is not its id's metric (the metric is code, never content)", () => {
    expect(bad((b) => { b.awards[1] = { ...b.awards[1]!, metric: "trips-completed" === b.awards[1]!["metric"] ? "flights-completed" : "trips-completed" }; })).toThrow(/not its metric/);
  });

  it("rejects extra or missing keys and a wrong format", () => {
    expect(bad((b) => { b.awards[0] = { ...b.awards[0]!, miles: 100 }; })).toThrow(DocumentValidationError);
    expect(bad((b) => { delete b.awards[0]!["title"]; })).toThrow(DocumentValidationError);
    expect(bad((b) => { b["format"] = "field-awards.v2"; })).toThrow(DocumentValidationError);
    expect(bad((b) => { b["extra"] = 1; })).toThrow(DocumentValidationError);
  });

  it("rejects a bad tag document", () => {
    const body = () => buildAircraftTagsBody(2) as { entries: Record<string, unknown>[] };
    const dup = body();
    dup.entries.push({ ...dup.entries[0]! });
    expect(() => parseAircraftTags(dup, 2)).toThrow(/appears twice/);
    const unknownTag = body();
    unknownTag.entries[0] = { ...unknownTag.entries[0]!, tags: [{ tag: "turbine", source: "provisional" }] };
    expect(() => parseAircraftTags(unknownTag, 2)).toThrow(DocumentValidationError);
    const repeated = body();
    repeated.entries[0] = { ...repeated.entries[0]!, tags: [{ tag: "heavy", source: "provisional" }, { tag: "heavy", source: "provisional" }] };
    expect(() => parseAircraftTags(repeated, 2)).toThrow(/repeats a tag/);
    expect(() => parseAircraftTags({ ...body(), entries: [] }, 2)).toThrow(DocumentValidationError);
  });

  it("rejects a Card whose keySource does not fit its module", () => {
    const body = buildClipperCardsBody(1, []) as { cards: Record<string, unknown>[] };
    body.cards[0] = { ...body.cards[0]!, keySource: "client_answer_text" };
    expect(() => parseClipperCards(body, 1)).toThrow(/keySource/);
  });

  it("validateDocument dispatches by name", () => {
    expect(() => validateDocument("field-awards", buildAircraftTagsBody(1), 1)).toThrow(DocumentValidationError);
    expect(() => validateDocument("aircraft-tags", buildAircraftTagsBody(1), 1)).not.toThrow();
  });
});

describe("manifest", () => {
  const meta = (name: DocumentMeta["name"], version: number, sha: string, at: string): DocumentMeta => ({
    name,
    version,
    format: `${name}.v1`,
    sha256: sha.repeat(64).slice(0, 64),
    byteSize: 100 + version,
    createdAt: new Date(at),
  });
  const docs = [meta("field-awards", 1, "a", "2026-11-02T10:00:00.123Z"), meta("clipper-cards", 1, "b", "2026-11-02T11:00:00.000Z"), meta("aircraft-tags", 1, "c", "2026-11-01T09:00:00.000Z")];

  it("keeps Unity's ManifestWire and ModuleWire fields, adds documents[], lists all eight modules enabled with null content", () => {
    const m = buildManifest(docs);
    expect(Object.keys(m).sort()).toEqual(["documents", "generatedAtUtc", "modules", "version"]);
    expect(m.modules).toHaveLength(8);
    expect(m.modules.map((x) => x.id).sort()).toEqual([...MODULE_IDS].sort());
    for (const mod of m.modules) expect(mod).toEqual({ id: mod.id, enabled: true, contentVersion: null, assetBundleUrl: null });
    expect(m.documents.map((d) => d.name)).toEqual(["aircraft-tags", "clipper-cards", "field-awards"]);
    expect(m.documents[2]).toEqual({ name: "field-awards", format: "field-awards.v1", version: 1, sha256: "a".repeat(64), byteSize: 101, url: "/v1/content/documents/field-awards/1" });
    expect(m.version).toMatch(/^m-[0-9a-f]{16}$/);
  });

  it("version is a pure function of the listed (name, version, sha256) and the modules: order and time do not matter", () => {
    const a = buildManifest(docs);
    const b = buildManifest([...docs].reverse());
    expect(b).toEqual(a);
    const later = docs.map((d) => ({ ...d, createdAt: new Date("2030-01-01T00:00:00Z"), byteSize: d.byteSize + 5 }));
    expect(buildManifest(later).version).toBe(a.version); // created_at and byteSize are not in the recipe
  });

  it("a new document version, or a changed digest, changes the version", () => {
    const base = buildManifest(docs).version;
    expect(buildManifest([meta("field-awards", 2, "a", "2026-11-03T00:00:00Z"), docs[1]!, docs[2]!]).version).not.toBe(base);
    expect(buildManifest([meta("field-awards", 1, "d", "2026-11-02T10:00:00.123Z"), docs[1]!, docs[2]!]).version).not.toBe(base);
  });

  // ASSUMPTION (not ruled): generatedAtUtc is the newest created_at of the listed documents, not the request time. A
  // request time would give two reads of one strong ETag different bytes.
  it("ASSUMPTION: generatedAtUtc is the newest created_at among the listed documents, a constant when there are none", () => {
    expect(buildManifest(docs).generatedAtUtc).toBe("2026-11-02T11:00:00.000Z");
    expect(buildManifest([]).generatedAtUtc).toBe(EMPTY_GENERATED_AT);
  });

  it("module entries follow the Unity ticket order", () => {
    expect(manifestModules().map((m) => m.id)).toEqual(["identifier", "aircraft-identifier-military", "tail-identifier", "airport-spotter", "atc-match", "call-sign-match", "code-search", "runway-identifier"]);
  });
});

describe("conditional requests and cache headers", () => {
  const tag = '"abc"';
  it("matches an exact, weak, listed or wildcard If-None-Match", () => {
    expect(ifNoneMatchHits('"abc"', tag)).toBe(true);
    expect(ifNoneMatchHits('W/"abc"', tag)).toBe(true);
    expect(ifNoneMatchHits('"x", "abc"', tag)).toBe(true);
    expect(ifNoneMatchHits(' "x" ,W/"abc" ', tag)).toBe(true);
    expect(ifNoneMatchHits("*", tag)).toBe(true);
  });
  it("does not match a different tag, an unquoted tag, an empty header or none", () => {
    expect(ifNoneMatchHits('"abd"', tag)).toBe(false);
    expect(ifNoneMatchHits("abc", tag)).toBe(false);
    expect(ifNoneMatchHits("", tag)).toBe(false);
    expect(ifNoneMatchHits(undefined, tag)).toBe(false);
  });
  it("the two exceptions to the global no-store are exactly design 7's", () => {
    expect(MANIFEST_CACHE_CONTROL).toBe("no-cache");
    expect(DOCUMENT_CACHE_CONTROL).toBe("private, max-age=31536000, immutable");
  });
});

describe("only document-store.ts writes content_documents", () => {
  const SRC = join(import.meta.dirname, "..", "src");
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
    });
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const WRITE = /\.\s*(?:insert|update|delete)\s*\(\s*(?:schema\s*\.\s*)?contentDocuments\b|\b(?:insert\s+into|update|delete\s+from|truncate(?:\s+table)?)\s+(?:only\s+)?(?:public\s*\.\s*)?"?content_documents\b/i;
  const ALLOWED = join("content", "documents", "document-store.ts");

  it("no other source file inserts, updates or deletes it", () => {
    const offenders = files(SRC)
      .filter((f) => !f.endsWith(ALLOWED))
      .filter((f) => WRITE.test(strip(readFileSync(f, "utf8"))))
      .map((f) => relative(SRC, f).split(sep).join("/"));
    expect(offenders).toEqual([]);
  });

  it("document-store.ts has no update or delete of it at all (insert-only)", () => {
    const store = strip(readFileSync(join(SRC, ALLOWED), "utf8"));
    expect(/\.\s*(?:update|delete)\s*\(\s*contentDocuments/.test(store)).toBe(false);
    expect(WRITE.test(store)).toBe(true); // the checker sees the one insert, so it is not vacuous
  });

  it("the checker catches seeded violations", () => {
    for (const code of [
      "await db.update(contentDocuments).set({ body: {} })",
      "tx.delete(contentDocuments)",
      "db.insert(schema.contentDocuments).values(x)",
      'await tx.execute(sql`UPDATE content_documents SET note = null`)',
      'sql`DELETE FROM "content_documents"`',
      "sql`insert into public.content_documents (name) values ('x')`",
      "sql`TRUNCATE content_documents`",
    ]) expect(WRITE.test(code), code).toBe(true);
    for (const code of ["db.select().from(contentDocuments)", "sql`SELECT * FROM content_documents`"]) expect(WRITE.test(code), code).toBe(false);
  });
});

// Filled from the first generation; see the GOLDEN test above before changing.
const GOLDEN = {
  awardsBytes: 9997,
  awardsSha: "4b4397dd5f7c919c6595c876d64eff3887ceeb2aaa46e4d138df576b65f5fa6c",
  tagsBytes: 8628,
  tagsSha: "e68909843812c709c16602a386972c704c87c5c00c9a6714ff86d4b9587de184",
};
