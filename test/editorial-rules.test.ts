import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EDITORIAL_KINDS as DB_KINDS, EDITORIAL_STATUSES } from "../src/db/enums.js";
import {
  EDITORIAL_DATA_KEYS,
  EDITORIAL_KINDS,
  EDITORIAL_TEXT_MAX,
  blankEditorialData,
  changedFields,
  dateKeyErrors,
  formatEditorialId,
  isEditorialKind,
  normaliseEditorialData,
  parseEditorialId,
  publishErrors,
  validDate,
  validInstagram,
} from "../src/content/editorial/editorial-rules.js";
import type { EditorialData } from "../src/content/editorial/editorial-rules.js";
import { MODULE_IDS } from "../src/rules/modules.js";

const good = (over: Partial<EditorialData> = {}): EditorialData => ({
  title: "A tidy title",
  aircraft: "Boeing 787-9",
  photographer: "A. Pilot",
  instagram: "@a.pilot",
  credit: "A. Pilot",
  description: "A factual description of the photo that is long enough.",
  correctAnswer: "Boeing 787",
  distractors: ["Airbus A350", "Boeing 777", "Airbus A330"],
  difficulty: "captain",
  factualSource: "https://example.com/source",
  ...over,
});

describe("editorial kinds", () => {
  it("is its own literal list, never derived from the Module ids", () => {
    expect([...EDITORIAL_KINDS]).toEqual(["identifier", "plane-of-the-day"]);
    expect(EDITORIAL_KINDS).toBe(DB_KINDS);
    // Plane of the Day is not a Module: the eight Modules stay eight.
    expect(MODULE_IDS).toHaveLength(8);
    expect((MODULE_IDS as readonly string[]).includes("plane-of-the-day")).toBe(false);
    expect(isEditorialKind("plane-of-the-day")).toBe(true);
    expect(isEditorialKind("airport-spotter")).toBe(false);
    expect([...EDITORIAL_STATUSES]).toEqual(["draft", "scheduled", "published", "archived"]);
  });
});

describe("normaliseEditorialData: shape and caps", () => {
  it("accepts the ten fields and returns them in storage order", () => {
    const { data, errors } = normaliseEditorialData(good());
    expect(errors).toEqual([]);
    expect(data).toEqual(good());
    expect(Object.keys(data as object)).toEqual([...EDITORIAL_DATA_KEYS]);
  });

  it("the blank shape is valid", () => {
    expect(normaliseEditorialData(blankEditorialData()).errors).toEqual([]);
  });

  it("refuses exactly 2 and 4 distractors, accepts exactly 3", () => {
    expect(normaliseEditorialData(good({ distractors: ["a", "b"] })).errors).toEqual(["data.distractors must be exactly 3 texts."]);
    expect(normaliseEditorialData(good({ distractors: ["a", "b", "c", "d"] })).errors).toEqual(["data.distractors must be exactly 3 texts."]);
    expect(normaliseEditorialData(good({ distractors: ["a", "b", "c"] })).errors).toEqual([]);
  });

  it("caps every string at 2400 code points (counted as code points, after the trim)", () => {
    const atCap = "x".repeat(EDITORIAL_TEXT_MAX);
    expect(normaliseEditorialData(good({ description: atCap })).errors).toEqual([]);
    expect(normaliseEditorialData(good({ description: `${atCap}x` })).errors).toEqual([`data.description is longer than ${EDITORIAL_TEXT_MAX} characters.`]);
    // 2400 astral characters are 4800 UTF-16 units but 2400 code points.
    expect(normaliseEditorialData(good({ title: "\u{1F6E9}".repeat(EDITORIAL_TEXT_MAX) })).errors).toEqual([]);
    expect(normaliseEditorialData(good({ title: "\u{1F6E9}".repeat(EDITORIAL_TEXT_MAX + 1) })).errors).toHaveLength(1);
    expect(normaliseEditorialData(good({ description: ` ${atCap} ` })).errors).toEqual([]); // trimmed first
    const long = "y".repeat(EDITORIAL_TEXT_MAX + 1);
    expect(normaliseEditorialData(good({ distractors: ["a", long, "c"] })).errors).toEqual([`data.distractors[1] is longer than ${EDITORIAL_TEXT_MAX} characters.`]);
  });

  it("turns CRLF into LF, allows LF, refuses every other control character", () => {
    expect(normaliseEditorialData(good({ description: "line one\r\nline two\nline three" })).data?.description).toBe("line one\nline two\nline three");
    for (const bad of ["tab\there", "nul\u0000x", "bell\u0007x", "lone\rcr", "del\u007fx", "c1\u0085x"]) {
      expect(normaliseEditorialData(good({ description: bad })).errors, JSON.stringify(bad)).toEqual(["data.description must not contain control characters (line breaks are allowed)."]);
    }
  });

  it("ASSUMPTION: text is trimmed on store", () => {
    const { data } = normaliseEditorialData(good({ title: "  spaced  ", distractors: [" a ", "b\n", "\nc"] }));
    expect(data?.title).toBe("spaced");
    expect(data?.distractors).toEqual(["a", "b", "c"]);
  });

  it("refuses a non-object, a missing field, a non-text field and an unknown key (imageUrl is never storable)", () => {
    expect(normaliseEditorialData(null).errors).toEqual(["data must be an object."]);
    expect(normaliseEditorialData([]).errors).toEqual(["data must be an object."]);
    const { title: _title, ...missing } = good();
    expect(normaliseEditorialData(missing).errors).toEqual(["data.title must be text."]);
    expect(normaliseEditorialData({ ...good(), title: 5 }).errors).toEqual(["data.title must be text."]);
    expect(normaliseEditorialData({ ...good(), imageUrl: "https://x/y.png" }).errors).toEqual(["data.imageUrl is not a field of an editorial item."]);
  });

  it("collects every problem at once", () => {
    const { data, errors } = normaliseEditorialData({ ...good(), title: 1, distractors: [], instagram: "no spaces allowed", difficulty: "ace" });
    expect(data).toBeNull();
    expect(errors).toHaveLength(4);
  });
});

describe("instagram, difficulty and dates", () => {
  it.each(["", "@a.pilot", "a_pilot", "A".repeat(30), "@" + "a".repeat(30), "https://www.instagram.com/a.pilot"])("accepts instagram %j", (value) => {
    expect(validInstagram(value)).toBe(true);
  });
  it.each(["a".repeat(31), "@", "a b", "@a-b", "http://www.instagram.com/x", "https://", "https://a b", "ftp://x", "@@a"])("refuses instagram %j", (value) => {
    expect(validInstagram(value)).toBe(false);
  });

  it("difficulty is empty or a backend rank id (display names are the website's)", () => {
    for (const rank of ["trainee", "first-officer", "captain", "check-airman", "chief-pilot", ""]) {
      expect(normaliseEditorialData(good({ difficulty: rank })).errors, rank).toEqual([]);
    }
    for (const bad of ["Captain", "First Officer", "ace", "chief_pilot"]) expect(normaliseEditorialData(good({ difficulty: bad })).errors, bad).toHaveLength(1);
  });

  it("validDate accepts real calendar dates only (2026-02-29 refused, leap day 2028-02-29 accepted)", () => {
    expect(validDate("2026-11-05")).toBe(true);
    expect(validDate("2028-02-29")).toBe(true);
    for (const bad of ["2026-02-29", "2026-13-01", "2026-00-10", "2026-04-31", "2026-1-05", "26-11-05", "2026-11-05T00:00:00Z", ""]) expect(validDate(bad), bad).toBe(false);
  });

  it("dateKey: an Identifier item has none; a Plane of the Day item has none or a real date", () => {
    expect(dateKeyErrors("identifier", null)).toEqual([]);
    expect(dateKeyErrors("identifier", "2026-11-05")).toEqual(["An Aircraft Identifier item has no date."]);
    expect(dateKeyErrors("plane-of-the-day", null)).toEqual([]);
    expect(dateKeyErrors("plane-of-the-day", "2026-11-05")).toEqual([]);
    expect(dateKeyErrors("plane-of-the-day", "2026-02-29")).toHaveLength(1);
  });
});

describe("publishErrors", () => {
  it("is empty for draft and archived whatever the content", () => {
    expect(publishErrors("identifier", "draft", blankEditorialData(), null)).toEqual([]);
    expect(publishErrors("plane-of-the-day", "archived", blankEditorialData(), null)).toEqual([]);
  });

  it("an Identifier item that is complete publishes; a scheduled one never does", () => {
    expect(publishErrors("identifier", "published", good(), null)).toEqual([]);
    expect(publishErrors("identifier", "scheduled", good(), null)).toEqual(["Aircraft Identifier supports draft or published content, not daily scheduling."]);
  });

  it("lists every unmet Identifier rule at once", () => {
    const errors = publishErrors("identifier", "published", good({ title: "ab", factualSource: "http://example.com", correctAnswer: "", distractors: ["", "", ""], difficulty: "" }), null);
    expect(errors).toEqual([
      "Add a descriptive title (at least 3 characters).",
      "Add an https factual source.",
      "Provide one correct answer and three distractors.",
      "All answer choices must be different.",
      "Choose a supported rank for the difficulty.",
    ]);
  });

  it("answer choices are distinct case-insensitively after trimming", () => {
    const errors = publishErrors("identifier", "published", good({ correctAnswer: "Boeing 787", distractors: ["BOEING 787", "Boeing 777", "Airbus A330"] }), null);
    expect(errors).toEqual(["All answer choices must be different."]);
    expect(publishErrors("identifier", "published", good({ distractors: ["Airbus A350", "Boeing 777", "airbus a350 "] }), null)).toEqual(["All answer choices must be different."]);
  });

  it("Plane of the Day needs a description of at least 15 characters and a date", () => {
    expect(publishErrors("plane-of-the-day", "published", good({ description: "x".repeat(14) }), "2026-11-05")).toEqual(["Add the photo's factual context (at least 15 characters)."]);
    expect(publishErrors("plane-of-the-day", "published", good({ description: "x".repeat(15) }), "2026-11-05")).toEqual([]);
    expect(publishErrors("plane-of-the-day", "scheduled", good(), null)).toEqual(["Choose the date this Plane of the Day is for."]);
    // The answer fields are not a Plane of the Day rule.
    expect(publishErrors("plane-of-the-day", "published", good({ correctAnswer: "", distractors: ["", "", ""], difficulty: "" }), "2026-11-05")).toEqual([]);
  });

  it("does not require the staff-typed credit (the public credit is the media licence credit)", () => {
    expect(publishErrors("plane-of-the-day", "published", good({ credit: "" }), "2026-11-05")).toEqual([]);
  });
});

describe("helpers", () => {
  it("changedFields names the fields that differ, in storage order", () => {
    expect(changedFields(good(), good())).toEqual([]);
    expect(changedFields(good(), good({ title: "New", distractors: ["a", "b", "c"], difficulty: "" }))).toEqual(["title", "distractors", "difficulty"]);
  });

  it("ed-<n> ids are strict", () => {
    expect(formatEditorialId(12)).toBe("ed-12");
    expect(parseEditorialId("ed-12")).toBe(12);
    for (const bad of ["ed-0", "ed-01", "ed-", "med-1", "ed-1x", "ed-1000000000000000", "12", " ed-1"]) expect(parseEditorialId(bad), bad).toBeUndefined();
  });
});

// docs/plans/website-content.md §0.3: the desks' question fields are editorial and never dealable. Nothing that deals, scores, serves a
// manifest or builds a release may read the editorial table or import the editorial module.
describe("ASSUMPTION: editorial items are never read by dealer, manifest or release code (source scan)", () => {
  const FORBIDDEN = /editorial_items|editorialItems|EditorialItemRow|content\/editorial|\.\.\/editorial\/|EditorialService|EditorialModule|editorial-rules/;

  function sourcesUnder(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...sourcesUnder(path));
      else if (entry.name.endsWith(".ts")) out.push(path);
    }
    return out;
  }

  it.each(["src/rounds", "src/rules", "src/content/documents", "src/content/releases"])("no file under %s mentions the editorial table or module", (dir) => {
    const files = sourcesUnder(join(process.cwd(), dir));
    expect(files.length, `${dir} should hold sources (the scan must not pass vacuously)`).toBeGreaterThan(0);
    for (const file of files) expect(FORBIDDEN.test(readFileSync(file, "utf8")), file).toBe(false);
  });

  it("the scan can see a reference (the pattern matches the real service file)", () => {
    expect(FORBIDDEN.test(readFileSync(join(process.cwd(), "src/content/editorial/editorial.service.ts"), "utf8"))).toBe(true);
  });
});
