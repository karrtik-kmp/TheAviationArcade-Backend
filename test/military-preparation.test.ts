import { describe, expect, it } from "vitest";
import { ADMIN_AUDIT_ACTIONS, PREP_STAGES as DB_STAGES } from "../src/db/enums.js";
import {
  APPROVED_LOCK_MESSAGE,
  DEMO_MEDIA_MESSAGE,
  NOT_PUBLISHED_MESSAGE,
  PREP_STAGES,
  RETIRED_MESSAGE,
  STALE_APPROVED_MESSAGE,
  changedEvidenceFields,
  changesApproved,
  guardsMedia,
  mediaGuardProblems,
  preparationBody,
  preparationErrors,
  preparationView,
  prepEvidenceSchema,
  stageErrors,
  transitionErrors,
} from "../src/content/preparation/military-preparation.js";
import type { PrepEvidence, PrepStage } from "../src/content/preparation/military-preparation.js";

// W3 commit 1 (docs/plans/website-content.md 3.3): the pure Military preparation rules, ported from website/lib/military.ts.

const blank = (): PrepEvidence => ({
  photoSource: "",
  licenseUrl: "",
  permission: "",
  attribution: "",
  referenceUrl: "",
  checklist: { identity: false, answers: false, crop: false, clipperCard: false },
  notes: "",
});
const rights = (over: Partial<PrepEvidence> = {}): PrepEvidence => ({ ...blank(), photoSource: "media", permission: "Client supplied under licence", attribution: "A. Pilot", ...over });
const prepared = (over: Partial<PrepEvidence> = {}): PrepEvidence => rights({ referenceUrl: "https://example.com/ref", ...over });
const previewed = (over: Partial<PrepEvidence> = {}): PrepEvidence => prepared({ checklist: { identity: false, answers: false, crop: true, clipperCard: false }, ...over });
const approved = (over: Partial<PrepEvidence> = {}): PrepEvidence =>
  prepared({ checklist: { identity: true, answers: true, crop: true, clipperCard: true }, ...over });

describe("stages", () => {
  it("are the five website stages in order, matching the database list", () => {
    expect([...PREP_STAGES]).toEqual(["missing_photo", "rights_checked", "content_prepared", "previewed", "approved"]);
    expect([...DB_STAGES]).toEqual([...PREP_STAGES]);
  });
  it("the media guard starts at rights_checked", () => {
    expect(PREP_STAGES.map(guardsMedia)).toEqual([false, true, true, true, true]);
  });
  it("content_prepare is an audit action", () => {
    expect(ADMIN_AUDIT_ACTIONS).toContain("content_prepare");
  });
});

describe("stageErrors (cumulative)", () => {
  it("missing_photo needs nothing", () => {
    expect(stageErrors("missing_photo", blank(), null)).toEqual([]);
  });

  it("rights_checked: a source, permission of 10+ trimmed characters and an attribution of 2+", () => {
    expect(stageErrors("rights_checked", blank(), null)).toEqual([
      "Choose where the photograph comes from.",
      "Record the permission or license terms in at least 10 characters.",
      "Add the attribution to display.",
    ]);
    expect(stageErrors("rights_checked", rights(), 5)).toEqual([]);
    expect(stageErrors("rights_checked", rights({ permission: "   123456789   " }), 5)).toEqual(["Record the permission or license terms in at least 10 characters."]);
    expect(stageErrors("rights_checked", rights({ permission: "1234567890" }), 5)).toEqual([]);
    expect(stageErrors("rights_checked", rights({ attribution: " A " }), 5)).toEqual(["Add the attribution to display."]);
    expect(stageErrors("rights_checked", rights({ attribution: "AB" }), 5)).toEqual([]);
  });

  it("photoSource media needs a linked photo; licensed needs an https licenseUrl; a linked photo is optional (guarded if set)", () => {
    expect(stageErrors("rights_checked", rights(), null)).toEqual(["Link the backend photo that supplies the photograph."]);
    const licensed = rights({ photoSource: "licensed" });
    expect(stageErrors("rights_checked", licensed, null)).toEqual(["Add the https link to the photograph's license or source."]);
    for (const bad of ["http://example.com/l", "https://nohost", "ftp://example.com/l", "https://exa mple.com/l", ""]) {
      expect(stageErrors("rights_checked", { ...licensed, licenseUrl: bad }, null), bad).toEqual(["Add the https link to the photograph's license or source."]);
    }
    expect(stageErrors("rights_checked", { ...licensed, licenseUrl: "https://example.com/licence" }, null)).toEqual([]);
  });

  it("content_prepared adds an https reference", () => {
    expect(stageErrors("content_prepared", rights(), 5)).toEqual(["Add an https reference that confirms the aircraft identity."]);
    expect(stageErrors("content_prepared", rights({ referenceUrl: "http://example.com/ref" }), 5)).toHaveLength(1);
    expect(stageErrors("content_prepared", prepared(), 5)).toEqual([]);
  });

  it("previewed adds the mobile crop; approved adds every checklist item", () => {
    expect(stageErrors("previewed", prepared(), 5)).toEqual(["Preview the mobile crop before marking the package previewed."]);
    expect(stageErrors("previewed", previewed(), 5)).toEqual([]);
    expect(stageErrors("approved", previewed(), 5)).toEqual(["Complete every preview checklist item before approval."]);
    for (const key of ["identity", "answers", "crop", "clipperCard"] as const) {
      const ev = approved({ checklist: { identity: true, answers: true, crop: true, clipperCard: true, [key]: false } });
      expect(stageErrors("approved", ev, 5), key).toHaveLength(key === "crop" ? 2 : 1);
    }
    expect(stageErrors("approved", approved(), 5)).toEqual([]);
  });

  it("every earlier rule still applies at a later stage", () => {
    const errors = stageErrors("approved", blank(), null);
    expect(errors.length).toBeGreaterThanOrEqual(6);
    expect(errors).toContain("Choose where the photograph comes from.");
    expect(errors).toContain("Add an https reference that confirms the aircraft identity.");
    expect(errors).toContain("Preview the mobile crop before marking the package previewed.");
  });
});

describe("transitionErrors", () => {
  const ok: Record<PrepStage, PrepEvidence> = { missing_photo: blank(), rights_checked: rights(), content_prepared: prepared(), previewed: previewed(), approved: approved() };

  it("moves forward one stage at a time", () => {
    for (let i = 0; i < PREP_STAGES.length - 1; i++) {
      const from = PREP_STAGES[i] as PrepStage;
      const to = PREP_STAGES[i + 1] as PrepStage;
      expect(transitionErrors(from, to, ok[to], 5), `${from} to ${to}`).toEqual([]);
    }
  });

  it("refuses a skip, naming the stage to reach first, whatever the evidence", () => {
    expect(transitionErrors("missing_photo", "content_prepared", ok.content_prepared, 5)).toEqual(["Move to Rights checked before Content prepared."]);
    expect(transitionErrors("missing_photo", "approved", ok.approved, 5)).toEqual(["Move to Rights checked before Approved."]);
    expect(transitionErrors("rights_checked", "previewed", ok.previewed, 5)).toEqual(["Move to Content prepared before Previewed."]);
    expect(transitionErrors("content_prepared", "approved", ok.approved, 5)).toEqual(["Move to Previewed before Approved."]);
  });

  it("may step back to any earlier stage (its own rules still hold) and stay at the same stage", () => {
    for (let from = 0; from < PREP_STAGES.length; from++) {
      for (let to = 0; to <= from; to++) {
        const stage = PREP_STAGES[to] as PrepStage;
        expect(transitionErrors(PREP_STAGES[from] as PrepStage, stage, ok[PREP_STAGES[from] as PrepStage], 5), `${PREP_STAGES[from]} to ${stage}`).toEqual([]);
      }
    }
    // Back to an earlier stage still needs that stage's evidence.
    expect(transitionErrors("approved", "rights_checked", blank(), 5)).toHaveLength(3);
  });

  it("an unknown stage is refused", () => {
    expect(transitionErrors("missing_photo", "bogus" as PrepStage, blank(), null)).toEqual(["Unknown preparation stage."]);
  });
});

describe("the approved lock", () => {
  const stored = { stage: "approved" as const, evidence: approved(), mediaId: 5 };

  it("an approved to approved save with different evidence or another photo is refused", () => {
    expect(changesApproved(stored, { stage: "approved", evidence: approved({ notes: "x" }), mediaId: 5 })).toBe(true);
    expect(changesApproved(stored, { stage: "approved", evidence: approved(), mediaId: 6 })).toBe(true);
    expect(changesApproved(stored, { stage: "approved", evidence: approved(), mediaId: null })).toBe(true);
    const item = { status: "approved", stale: false };
    expect(preparationErrors(item, stored, { stage: "approved", evidence: approved({ notes: "x" }), mediaId: 5 })).toEqual([APPROVED_LOCK_MESSAGE]);
  });

  it("the same evidence and photo (key order aside) is not a change", () => {
    const reordered = JSON.parse(JSON.stringify(approved())) as PrepEvidence;
    expect(changesApproved({ ...stored, evidence: Object.fromEntries(Object.entries(reordered).reverse()) }, { stage: "approved", evidence: approved(), mediaId: 5 })).toBe(false);
  });

  it("stepping back to previewed, or moving forward into approved, is not the lock", () => {
    expect(changesApproved(stored, { stage: "previewed", evidence: previewed({ notes: "x" }), mediaId: 6 })).toBe(false);
    expect(changesApproved({ stage: "previewed", evidence: previewed(), mediaId: 5 }, { stage: "approved", evidence: approved(), mediaId: 5 })).toBe(false);
    expect(changesApproved({ stage: null, evidence: null, mediaId: null }, { stage: "approved", evidence: approved(), mediaId: 5 })).toBe(false);
  });
});

describe("a stale approved package", () => {
  const stored = { stage: "approved" as const, evidence: approved(), mediaId: 5 };
  const same = { stage: "approved" as const, evidence: approved(), mediaId: 5 };
  it("cannot be re-confirmed at approved, even with the stored evidence and photo", () => {
    expect(preparationErrors({ status: "approved", stale: true }, stored, same)).toEqual([STALE_APPROVED_MESSAGE]);
    expect(STALE_APPROVED_MESSAGE).toBe("This package changed since approval. Step it back to Previewed and preview it again.");
  });
  it("a current approved package saved unchanged is fine, and a stale one may step back to previewed or below", () => {
    expect(preparationErrors({ status: "approved", stale: false }, stored, same)).toEqual([]);
    expect(preparationErrors({ status: "approved", stale: true }, stored, { stage: "previewed", evidence: previewed(), mediaId: 5 })).toEqual([]);
  });
  it("a stale package below approved may be re-confirmed in place", () => {
    const at = { stage: "rights_checked" as const, evidence: rights(), mediaId: 5 };
    expect(preparationErrors({ status: "approved", stale: true }, at, at)).toEqual([]);
  });
  it("a stale approved package that also changes the photo reports the lock first", () => {
    expect(preparationErrors({ status: "approved", stale: true }, stored, { ...same, mediaId: 6 })).toEqual([APPROVED_LOCK_MESSAGE]);
  });
});

describe("preparationErrors", () => {
  const never = { stage: null, evidence: null, mediaId: null };
  it("a never prepared item stands at the first stage", () => {
    expect(preparationErrors({ status: "approved", stale: false }, never, { stage: "rights_checked", evidence: rights(), mediaId: 5 })).toEqual([]);
    expect(preparationErrors({ status: "approved", stale: false }, never, { stage: "content_prepared", evidence: prepared(), mediaId: 5 })).toEqual(["Move to Rights checked before Content prepared."]);
    expect(preparationErrors({ status: "approved", stale: false }, never, { stage: "missing_photo", evidence: blank(), mediaId: null })).toEqual([]);
  });
  it("ASSUMPTION: a retired item is refused with the one reason, before any other rule", () => {
    expect(preparationErrors({ status: "retired", stale: false }, never, { stage: "approved", evidence: blank(), mediaId: null })).toEqual([RETIRED_MESSAGE]);
  });
});

describe("mediaGuardProblems", () => {
  it("passes a published, non-demo photo", () => {
    expect(mediaGuardProblems({ state: "published", publishedVersion: 1, ownerIsDemo: false })).toEqual([]);
  });
  it("refuses every other state, a missing media row and a demo owner", () => {
    for (const state of ["unverified", "withdrawn"]) expect(mediaGuardProblems({ state, publishedVersion: null, ownerIsDemo: false })).toEqual([NOT_PUBLISHED_MESSAGE]);
    expect(mediaGuardProblems({ state: "published", publishedVersion: null, ownerIsDemo: false })).toEqual([NOT_PUBLISHED_MESSAGE]);
    expect(mediaGuardProblems({ state: "published", publishedVersion: 2, ownerIsDemo: true })).toEqual([DEMO_MEDIA_MESSAGE]);
    expect(mediaGuardProblems({ state: "withdrawn", publishedVersion: null, ownerIsDemo: true })).toEqual([NOT_PUBLISHED_MESSAGE, DEMO_MEDIA_MESSAGE]);
    expect(mediaGuardProblems(undefined)).toEqual(["No such media item."]);
    expect(NOT_PUBLISHED_MESSAGE).toBe("The linked photo must be a published photo.");
  });
});

describe("the strict evidence and body schemas", () => {
  const body = { version: 1, stage: "rights_checked", evidence: rights(), mediaId: "med-5" };

  it("accepts a well-formed evidence object and body", () => {
    expect(prepEvidenceSchema.safeParse(blank()).success).toBe(true);
    expect(preparationBody.safeParse(body).success).toBe(true);
    expect(preparationBody.safeParse({ ...body, mediaId: null }).success).toBe(true);
  });

  it("refuses the website's question fields: answer, distractors, aliases, hint, reveal, submissionId", () => {
    for (const key of ["answer", "distractors", "aliases", "hint", "reveal", "submissionId", "extra"]) {
      expect(prepEvidenceSchema.safeParse({ ...blank(), [key]: key === "distractors" || key === "aliases" ? [] : "x" }).success, key).toBe(false);
    }
  });

  it("refuses a missing key, a wrong type, a bad photoSource, an extra checklist key and over-long text", () => {
    const { notes: _notes, ...noNotes } = blank();
    expect(prepEvidenceSchema.safeParse(noNotes).success).toBe(false);
    expect(prepEvidenceSchema.safeParse({ ...blank(), notes: 5 }).success).toBe(false);
    expect(prepEvidenceSchema.safeParse({ ...blank(), photoSource: "submission" }).success).toBe(false);
    expect(prepEvidenceSchema.safeParse({ ...blank(), checklist: { ...blank().checklist, extra: true } }).success).toBe(false);
    expect(prepEvidenceSchema.safeParse({ ...blank(), checklist: { identity: true } }).success).toBe(false);
    expect(prepEvidenceSchema.safeParse({ ...blank(), licenseUrl: "x".repeat(601) }).success).toBe(false);
    expect(prepEvidenceSchema.safeParse({ ...blank(), licenseUrl: "x".repeat(600) }).success).toBe(true);
    expect(prepEvidenceSchema.safeParse({ ...blank(), referenceUrl: "x".repeat(601) }).success).toBe(false);
    expect(prepEvidenceSchema.safeParse({ ...blank(), permission: "x".repeat(2401) }).success).toBe(false);
    expect(prepEvidenceSchema.safeParse({ ...blank(), notes: "x".repeat(2401) }).success).toBe(false);
    expect(prepEvidenceSchema.safeParse({ ...blank(), attribution: "x".repeat(161) }).success).toBe(false);
    expect(prepEvidenceSchema.safeParse({ ...blank(), attribution: "x".repeat(160) }).success).toBe(true);
  });

  it("the body is strict: extra keys, a bad stage, version or mediaId, and a missing key are refused", () => {
    for (const bad of [
      { ...body, extra: 1 },
      { ...body, stage: "done" },
      { ...body, version: 0 },
      { ...body, version: 1.5 },
      { ...body, mediaId: "med-0" },
      { ...body, mediaId: "x" },
      { ...body, mediaId: 5 },
      { ...body, status: "approved" },
    ]) {
      expect(preparationBody.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    for (const key of Object.keys(body)) {
      const { [key]: _gone, ...rest } = body as Record<string, unknown>;
      expect(preparationBody.safeParse(rest).success, key).toBe(false);
    }
  });
});

describe("preparationView and changedEvidenceFields", () => {
  it("is null for a never prepared row and stale when the item version moved past prep_version", () => {
    expect(preparationView({ version: 1, prepStage: null, prepEvidence: null, prepVersion: null })).toBeNull();
    expect(preparationView({ version: 3, prepStage: "approved", prepEvidence: approved(), prepVersion: 3 })).toEqual({ stage: "approved", evidence: approved(), stale: false });
    expect(preparationView({ version: 4, prepStage: "approved", prepEvidence: approved(), prepVersion: 3 })?.stale).toBe(true);
  });
  it("names the differing evidence fields and never their text", () => {
    expect(changedEvidenceFields(null, blank())).toEqual([]);
    expect(changedEvidenceFields(blank(), rights())).toEqual(["evidence.photoSource", "evidence.permission", "evidence.attribution"]);
    expect(changedEvidenceFields(approved(), previewed())).toEqual(["evidence.checklist.identity", "evidence.checklist.answers", "evidence.checklist.clipperCard"]);
  });
});
