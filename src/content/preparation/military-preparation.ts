import { z } from "zod";
import { PREP_STAGES } from "../../db/enums.js";
import type { PrepStage } from "../../db/enums.js";
import { canonicalJson } from "../import-plan.js";
import { MEDIA_ID_PATTERN } from "../item-media-id.js";

/**
 * Pure rules of Military preparation (docs/plans/website-content.md W3 section 3.3): a port of the website's `lib/military.ts`
 * (`stageErrors`, `transitionError`, `parsePackageData`) and `lib/editorial/store.ts` (`planDraft`, `draftPhotoGuard`).
 * Nothing here touches the database. The evidence is what staff record about a photo's rights and a preview; it holds NO question,
 * answer, distractor, alias, hint or reveal (the question comes only from the client's sheet).
 */

export { PREP_STAGES };
export type { PrepStage };

export const MILITARY_MODULE = "aircraft-identifier-military";

export const STAGE_NAMES: Record<PrepStage, string> = {
  missing_photo: "Missing photo",
  rights_checked: "Rights checked",
  content_prepared: "Content prepared",
  previewed: "Previewed",
  approved: "Approved",
};

export const PHOTO_SOURCES = ["", "media", "licensed"] as const;
export type PhotoSource = (typeof PHOTO_SOURCES)[number];

export const CHECKLIST_KEYS = ["identity", "answers", "crop", "clipperCard"] as const;

export type PrepEvidence = {
  /** "media": the linked backend photo; "licensed": a separately licensed photograph (the https `licenseUrl` is the proof). */
  photoSource: PhotoSource;
  licenseUrl: string;
  permission: string;
  attribution: string;
  referenceUrl: string;
  checklist: { identity: boolean; answers: boolean; crop: boolean; clipperCard: boolean };
  notes: string;
};

/** The evidence, strict: every key present, no other key (so no `answer`, `distractors`, `aliases`, `hint` or `reveal`). */
export const prepEvidenceSchema = z.strictObject({
  photoSource: z.enum(PHOTO_SOURCES),
  licenseUrl: z.string().max(600),
  permission: z.string().max(2400),
  attribution: z.string().max(160),
  referenceUrl: z.string().max(600),
  checklist: z.strictObject({ identity: z.boolean(), answers: z.boolean(), crop: z.boolean(), clipperCard: z.boolean() }),
  notes: z.string().max(2400),
});

const itemVersion = z.number().int().min(1).max(2_147_483_647);

/** PUT .../items/{id}/preparation body. Strict. */
export const preparationBody = z.strictObject({
  version: itemVersion,
  stage: z.enum(PREP_STAGES),
  evidence: prepEvidenceSchema,
  mediaId: z.union([z.string().regex(MEDIA_ID_PATTERN), z.null()]),
});
export type PreparationBody = z.infer<typeof preparationBody>;

export const NOT_PUBLISHED_MESSAGE = "The linked photo must be a published photo.";
export const DEMO_MEDIA_MESSAGE = "The linked photo belongs to the shared demo account and cannot be used.";
export const APPROVED_LOCK_MESSAGE = "Step an approved package back to Previewed before changing it.";
export const STALE_APPROVED_MESSAGE = "This package changed since approval. Step it back to Previewed and preview it again.";
export const RETIRED_MESSAGE = "A retired item cannot be prepared. Restore it first.";

export function stageIndex(stage: string): number {
  return (PREP_STAGES as readonly string[]).indexOf(stage);
}

/** True from `rights_checked` on, where the linked photo must be a real published one. */
export function guardsMedia(stage: string): boolean {
  return stageIndex(stage) >= 1;
}

const https = (s: string) => /^https:\/\/[^\s/]+\.[^\s]+$/i.test(s.trim());

/** What is still missing before a package can stand at `stage`. Each stage includes the earlier ones. */
export function stageErrors(stage: PrepStage, evidence: PrepEvidence, mediaId: number | null): string[] {
  const at = stageIndex(stage);
  const errors: string[] = [];
  if (at >= 1) {
    if (evidence.photoSource === "media" && mediaId === null) errors.push("Link the backend photo that supplies the photograph.");
    else if (evidence.photoSource === "licensed" && !https(evidence.licenseUrl)) errors.push("Add the https link to the photograph's license or source.");
    else if (evidence.photoSource === "") errors.push("Choose where the photograph comes from.");
    if (evidence.permission.trim().length < 10) errors.push("Record the permission or license terms in at least 10 characters.");
    if (evidence.attribution.trim().length < 2) errors.push("Add the attribution to display.");
  }
  if (at >= 2 && !https(evidence.referenceUrl)) errors.push("Add an https reference that confirms the aircraft identity.");
  if (at >= 3 && !evidence.checklist.crop) errors.push("Preview the mobile crop before marking the package previewed.");
  if (at >= 4 && !CHECKLIST_KEYS.every((key) => evidence.checklist[key] === true)) {
    errors.push("Complete every preview checklist item before approval.");
  }
  return errors;
}

/** Packages move forward one stage at a time and may step back to any earlier stage. */
export function transitionErrors(from: PrepStage, to: PrepStage, evidence: PrepEvidence, mediaId: number | null): string[] {
  const a = stageIndex(from);
  const b = stageIndex(to);
  if (b < 0) return ["Unknown preparation stage."];
  if (b > a + 1) return [`Move to ${STAGE_NAMES[PREP_STAGES[a + 1] as PrepStage]} before ${STAGE_NAMES[to]}.`];
  return stageErrors(to, evidence, mediaId);
}

/** What a stored item looked like before the save (`null` stage = never prepared, which stands at the first stage). */
export type StoredPreparation = { stage: PrepStage | null; evidence: unknown; mediaId: number | null };

/** True when saving `next` would change an approved package (its evidence or its linked photo). */
export function changesApproved(stored: StoredPreparation, next: { stage: PrepStage; evidence: PrepEvidence; mediaId: number | null }): boolean {
  return (
    stored.stage === "approved" &&
    next.stage === "approved" &&
    (canonicalJson(stored.evidence) !== canonicalJson(next.evidence) || stored.mediaId !== next.mediaId)
  );
}

/**
 * Every refusal that needs no database read, collected: a retired item (ASSUMPTION), the approved lock and the cumulative stage
 * rules. The media guard is separate (`mediaGuardProblems`): it needs the media row.
 */
export function preparationErrors(
  item: { status: string; stale: boolean },
  stored: StoredPreparation,
  next: { stage: PrepStage; evidence: PrepEvidence; mediaId: number | null },
): string[] {
  if (item.status === "retired") return [RETIRED_MESSAGE];
  if (changesApproved(stored, next)) return [APPROVED_LOCK_MESSAGE];
  // A stale approved package (the item changed after approval: relink, re-import, edit) cannot be re-confirmed in place, even
  // with the stored values: the photo or the question may no longer be what was approved.
  if (item.stale && stored.stage === "approved" && next.stage === "approved") return [STALE_APPROVED_MESSAGE];
  return transitionErrors(stored.stage ?? "missing_photo", next.stage, next.evidence, next.mediaId);
}

/** The media guard (from `rights_checked`): the linked photo must be published and not owned by the shared demo account. */
export function mediaGuardProblems(media: { state: string; publishedVersion: number | null; ownerIsDemo: boolean } | undefined): string[] {
  if (!media) return ["No such media item."];
  const problems: string[] = [];
  if (!(media.state === "published" && media.publishedVersion !== null)) problems.push(NOT_PUBLISHED_MESSAGE);
  if (media.ownerIsDemo) problems.push(DEMO_MEDIA_MESSAGE);
  return problems;
}

export type PreparationView = { stage: PrepStage; evidence: PrepEvidence; stale: boolean };

/** The wire form of a row's preparation, or null when never prepared. `stale` = a later change bumped the item version past `prep_version`. */
export function preparationView(row: { version: number; prepStage: string | null; prepEvidence: unknown; prepVersion: number | null }): PreparationView | null {
  if (row.prepStage === null || row.prepVersion === null) return null;
  return { stage: row.prepStage as PrepStage, evidence: row.prepEvidence as PrepEvidence, stale: row.version !== row.prepVersion };
}

/** The evidence of an item never prepared (what the first save is compared with in the audit row). */
export const BLANK_EVIDENCE: PrepEvidence = {
  photoSource: "",
  licenseUrl: "",
  permission: "",
  attribution: "",
  referenceUrl: "",
  checklist: { identity: false, answers: false, crop: false, clipperCard: false },
  notes: "",
};

/** Which evidence fields differ (for the audit row; never their text). `before` null = never prepared. */
export function changedEvidenceFields(before: unknown, after: PrepEvidence): string[] {
  const old = (before ?? BLANK_EVIDENCE) as Record<string, unknown>;
  const out: string[] = [];
  for (const key of ["photoSource", "licenseUrl", "permission", "attribution", "referenceUrl", "notes"] as const) {
    if (canonicalJson(old[key]) !== canonicalJson(after[key])) out.push(`evidence.${key}`);
  }
  const oldList = (old["checklist"] ?? {}) as Record<string, unknown>;
  for (const key of CHECKLIST_KEYS) {
    if (oldList[key] !== after.checklist[key]) out.push(`evidence.checklist.${key}`);
  }
  return out;
}
