import { z } from "zod";
import { militaryCardKey } from "../../rules/clipper-cards.js";
import { tripCoverage } from "../../rules/dealer.js";
import { RANKS, isRank } from "../../rules/ranks.js";
import type { Rank } from "../../rules/ranks.js";
import { FLIGHTS_PER_TRIP } from "../../rules/trips.js";
import { compareIds } from "../content-modules.js";
import { rowToDealItem } from "../deal-items.js";
import { formatMediaId } from "../item-media-id.js";

/**
 * Pure rules of Military releases (docs/plans/website-content.md W3 section 3.3): a port of the website's `lib/military.ts`
 * (`releaseBasis`, `releaseErrors`) and `lib/editorial/store.ts` (`planUpload`, `planActivate`, `planRestore`) onto the backend's
 * rows. Nothing here touches the database. A release is RECORDED, NOT DELIVERED: no player route reads it and nothing deals from it.
 */

export const RELEASE_MODULE = "aircraft-identifier-military";
export const MAX_RELEASE_ITEMS = 2000;
export const MAX_RELEASE_NOTE = 500;
/** Ids longer than this cannot exist (`mil-a<n>` is at most 11 characters); the same cap as the Trip coverage route. */
export const MAX_RELEASE_ITEM_ID = 64;
/** `GET .../releases` returns this many releases, newest first. */
export const RELEASES_LISTED = 50;

const pointerVersion = z.number().int().min(0).max(2_147_483_647);
const note = z.string().max(MAX_RELEASE_NOTE).optional();

/** POST .../releases body. Strict. `previewed` is checked by the rules (422), not the schema, so a wrong value is a clear refusal. */
export const uploadBody = z.strictObject({
  itemIds: z.array(z.string().min(1).max(MAX_RELEASE_ITEM_ID)).min(1).max(MAX_RELEASE_ITEMS),
  basis: z.string().min(1).max(65_536),
  previewed: z.boolean(),
  note,
});
export type UploadBody = z.infer<typeof uploadBody>;

/** POST .../releases/{version}/activate and POST .../releases/restore body. Strict. */
export const pointerBody = z.strictObject({ expectedPointerVersion: pointerVersion, note });
export type PointerBody = z.infer<typeof pointerBody>;

/** A trimmed note, or null when blank or absent. */
export function cleanNote(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

// ---- messages (shared with the tests) ----

export const BASIS_CHANGED_MESSAGE = "Packages changed since this preview. Refresh and review the sample Trips again.";
export const NOT_PREVIEWED_MESSAGE = "Review the sample Trips for every rank before releasing.";
export const SAME_AS_CURRENT_MESSAGE = "These package versions are already the current release.";
export const CANNOT_RELEASE_MESSAGE = "This batch cannot be released yet.";
export const POINTER_CHANGED_MESSAGE = "Another editor changed the release. Refresh to see it.";
export const NOT_UPLOADED_MESSAGE = "Only an uploaded release can be made live. Restore steps back to earlier ones.";
export const NOTHING_TO_RESTORE_MESSAGE = "There is no earlier release to restore.";
export const CHANGED_SINCE_UPLOAD_MESSAGE = "The packages or photos changed since this release was uploaded. Upload a new release.";
export const RESTORE_PHOTOS_MESSAGE = "A photo of the earlier release is no longer published, so it cannot be restored.";

// ---- basis ----

/** Identifies the exact item versions a preview or release was built from: the sorted `<id>:<version>` joined by `,`. */
export function releaseBasis(items: readonly { id: string; version: number }[]): string {
  return items
    .map((item) => `${item.id}:${item.version}`)
    .sort()
    .join(",");
}

// ---- pointer ----

/** The release pointer of a module: the newest activation row, or nothing current at version 0. */
export type Pointer = { current: number | null; history: number[]; version: number };

export const EMPTY_POINTER: Pointer = { current: null, history: [], version: 0 };

export type ActivationRow = { sequence: number; releaseVersion: number; history: readonly number[] };

export function pointerOf(newest: ActivationRow | undefined): Pointer {
  return newest ? { current: newest.releaseVersion, history: [...newest.history], version: newest.sequence } : { current: null, history: [], version: 0 };
}

export type ReleaseStatus = "uploaded" | "released";

/** A refusal the rules return (never thrown); the caller turns it into the response. */
export type Refusal = {
  status: 404 | 409 | 422;
  code: "not_found" | "version_conflict" | "nothing_to_publish" | "content_invalid";
  message: string;
  errors?: string[];
};

/** The next pointer for an activation. `history` gains the previous current (nothing when none was current). */
export function planActivate(
  pointer: Pointer,
  expectedPointerVersion: number,
  candidate: { version: number; basis: string; status: ReleaseStatus } | undefined,
  currentBasis: string | undefined,
): { next: Pointer } | { refusal: Refusal } {
  if (expectedPointerVersion !== pointer.version) return { refusal: { status: 409, code: "version_conflict", message: POINTER_CHANGED_MESSAGE } };
  if (!candidate) return { refusal: { status: 404, code: "not_found", message: "This release does not exist." } };
  if (candidate.status !== "uploaded") return { refusal: { status: 422, code: "content_invalid", message: NOT_UPLOADED_MESSAGE } };
  if (currentBasis !== undefined && currentBasis === candidate.basis) {
    return { refusal: { status: 409, code: "nothing_to_publish", message: SAME_AS_CURRENT_MESSAGE } };
  }
  return {
    next: {
      current: candidate.version,
      history: pointer.current === null ? [...pointer.history] : [...pointer.history, pointer.current],
      version: pointer.version + 1,
    },
  };
}

/** The next pointer for a restore: the stack is popped. */
export function planRestore(pointer: Pointer, expectedPointerVersion: number): { next: Pointer } | { refusal: Refusal } {
  if (expectedPointerVersion !== pointer.version) return { refusal: { status: 409, code: "version_conflict", message: POINTER_CHANGED_MESSAGE } };
  const history = [...pointer.history];
  const previous = history.pop();
  if (previous === undefined) return { refusal: { status: 422, code: "content_invalid", message: NOTHING_TO_RESTORE_MESSAGE } };
  return { next: { current: previous, history, version: pointer.version + 1 } };
}

// ---- upload ----

/** The columns of a stored item the upload rules read. */
export type ReleaseItemRow = {
  id: string;
  rank: string;
  status: string;
  version: number;
  data: unknown;
  cardKey: string | null;
  prepStage: string | null;
  prepVersion: number | null;
  mediaId: number | null;
};

/** What the upload needs of a linked photo, read FOR SHARE: its state and the PUBLISHED version's hash and credit. */
export type MediaFact = {
  id: number;
  state: string;
  publishedVersion: number | null;
  ownerIsDemo: boolean;
  sha256: string | null;
  credit: string | null;
};

/**
 * Selection problems that are not about readiness: a repeated id, an id the module does not store (reported separately by the
 * caller as `unknown_item_ids`) and a retired item. Returned as the first set of plain-English reasons.
 */
export function selectionErrors(itemIds: readonly string[], rows: ReadonlyMap<string, ReleaseItemRow>): { unknown: string[]; errors: string[] } {
  const errors: string[] = [];
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const id of itemIds) (seen.has(id) ? duplicated : seen).add(id);
  if (duplicated.size > 0) errors.push(`Each item may be chosen once: ${[...duplicated].join(", ")} repeated.`);
  const unknown = [...seen].filter((id) => !rows.has(id));
  for (const id of seen) if (rows.get(id)?.status === "retired") errors.push(`${id}: the item is retired. Restore it or leave it out.`);
  return { unknown, errors };
}

const isStale = (row: ReleaseItemRow): boolean => row.prepVersion !== null && row.prepVersion !== row.version;

/** Every item `approved` and not stale; every item a published, non-demo photo; no two items share a photo hash. */
export function readinessErrors(chosen: readonly ReleaseItemRow[], media: ReadonlyMap<number, MediaFact>): string[] {
  const errors: string[] = [];
  const hashes = new Map<string, string>();
  for (const row of chosen) {
    if (row.prepStage !== "approved") errors.push(`${row.id}: the package is not approved (it is at ${row.prepStage ?? "no stage"}).`);
    else if (isStale(row)) errors.push(`${row.id}: the package changed after approval. Step it back to Previewed and approve it again.`);
    if (row.mediaId === null) {
      errors.push(`${row.id}: link a published photo. A release needs a stored photograph for every item.`);
      continue;
    }
    const fact = media.get(row.mediaId);
    if (!fact) {
      errors.push(`${row.id}: the linked photo ${formatMediaId(row.mediaId)} does not exist.`);
      continue;
    }
    if (!(fact.state === "published" && fact.publishedVersion !== null && fact.sha256 !== null)) {
      errors.push(`${row.id}: the linked photo ${formatMediaId(row.mediaId)} is not published.`);
      continue;
    }
    if (fact.ownerIsDemo) {
      errors.push(`${row.id}: the linked photo ${formatMediaId(row.mediaId)} belongs to the shared demo account and cannot be used.`);
      continue;
    }
    const other = hashes.get(fact.sha256);
    if (other !== undefined) errors.push(`${row.id}: uses the same photograph as ${other}.`);
    else hashes.set(fact.sha256, row.id);
  }
  return errors;
}

/** Flights a Trip at each rank would hold, by the backend's own Military dealer (nearest-ranks; ASSUMPTION: C13 is open). */
export function releaseCoverage(chosen: readonly ReleaseItemRow[]): { perRank: Record<Rank, number>; unusable: string[]; noSource: string[] } {
  const ordered = [...chosen].sort((a, b) => compareIds(a.id, b.id));
  const pool = [];
  const unusable: string[] = [];
  const noSource: string[] = [];
  for (const row of ordered) {
    const item = rowToDealItem(row);
    if (!item) unusable.push(row.id);
    else if (item.photoKey === "") noSource.push(row.id); // a blank source file cannot be dealt: name it instead of dropping it silently
    else pool.push(item);
  }
  return { perRank: tripCoverage(RELEASE_MODULE, pool), unusable, noSource };
}

/** One reason per rank whose Trip cannot be filled, plus the items with no usable question. */
export function coverageErrors(coverage: { perRank: Record<Rank, number>; unusable: readonly string[]; noSource?: readonly string[] }): string[] {
  const errors = coverage.unusable.map((id) => `${id}: the stored question is not usable (an answer and three wrong answers are needed).`);
  for (const id of coverage.noSource ?? []) errors.push(`${id}: the stored question has no source file.`);
  for (const rank of RANKS) {
    const n = coverage.perRank[rank];
    if (n < FLIGHTS_PER_TRIP) errors.push(`${rank}: a Trip would hold ${n} of ${FLIGHTS_PER_TRIP} Flights; add more approved questions.`);
  }
  return errors;
}

/** The Card key to freeze into the release row: the item's own key, else the key of its answer as stored (null when blank). */
export function releaseCardKey(row: Pick<ReleaseItemRow, "cardKey" | "data">): string | null {
  if (row.cardKey) return row.cardKey;
  const answer = (row.data as { answer?: unknown } | null)?.answer;
  return (typeof answer === "string" ? militaryCardKey(answer) : "") || null;
}

/** Items whose preparation is approved and current, per rank. Non-blocking: shows an own-rank shortage next to the dealer's gate (C13). */
export function ownRankCounts(rows: readonly Pick<ReleaseItemRow, "rank" | "status" | "version" | "prepStage" | "prepVersion">[]): Record<Rank, number> {
  const out = Object.fromEntries(RANKS.map((rank) => [rank, 0])) as Record<Rank, number>;
  for (const row of rows) {
    if (row.status !== "approved" || row.prepStage !== "approved" || row.prepVersion !== row.version) continue;
    if (isRank(row.rank)) out[row.rank] += 1;
  }
  return out;
}

// ---- activate and restore guards ----

/** A release item as stored (frozen at upload). */
export type FrozenItem = { itemId: string; itemVersion: number; mediaId: number; mediaVersion: number; photoSha256: string };
/** A content item as it is now: only what the guard compares. */
export type CurrentItem = { status: string; version: number };

/** (c) For one frozen item: the photo is still published at the frozen version with the frozen hash. The media revision is not compared. */
export function photoErrors(item: FrozenItem, fact: MediaFact | undefined): string[] {
  const label = `${item.itemId}: photo ${formatMediaId(item.mediaId)}`;
  if (!fact || fact.state !== "published") return [`${label} is no longer published.`];
  if (fact.publishedVersion !== item.mediaVersion) return [`${label} was republished (version ${fact.publishedVersion ?? "none"}, the release froze version ${item.mediaVersion}).`];
  if (fact.sha256 !== item.photoSha256) return [`${label} no longer matches the file the release froze.`];
  return [];
}

/**
 * The activation guard, exactly: (a) every release item still exists and is not retired; (b) every release item's version equals the
 * frozen one; (c) every release photo is still published at the frozen version with the frozen hash. One reason per change.
 */
export function activationGuardErrors(frozen: readonly FrozenItem[], current: ReadonlyMap<string, CurrentItem>, media: ReadonlyMap<number, MediaFact>): string[] {
  const errors: string[] = [];
  for (const item of frozen) {
    const now = current.get(item.itemId);
    if (!now || now.status === "retired") {
      errors.push(`${item.itemId}: the item is retired or no longer stored.`);
    } else if (now.version !== item.itemVersion) {
      errors.push(`${item.itemId}: the item changed since the upload (version ${item.itemVersion}, now ${now.version}).`);
    }
    errors.push(...photoErrors(item, media.get(item.mediaId)));
  }
  return errors;
}

/** The restore guard: only (c), the photos. A restored release does not re-check the items. */
export function restoreGuardErrors(frozen: readonly FrozenItem[], media: ReadonlyMap<number, MediaFact>): string[] {
  return frozen.flatMap((item) => photoErrors(item, media.get(item.mediaId)));
}
