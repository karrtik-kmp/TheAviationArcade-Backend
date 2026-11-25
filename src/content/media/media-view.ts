import type { MediaRightsStatement } from "../../db/enums.js";
import { mediaItems, mediaSubmissions, mediaVersions } from "../../db/schema.js";

export type MediaItemRow = typeof mediaItems.$inferSelect;
export type MediaVersionRow = typeof mediaVersions.$inferSelect;
export type MediaSubmissionRow = typeof mediaSubmissions.$inferSelect;

export type MediaLicenceView = {
  credit: string | null;
  licenceName: string | null;
  licenceUrl: string | null;
  sourceUrl: string | null;
  attributionText: string | null;
  creditRequired: boolean;
};

/** The photographer's rights statement for a file version. `statedBy` (a principal) is shown to admin callers only. */
export type MediaRightsView = { statement: MediaRightsStatement; statedAt: string; statedBy?: string };

export type MediaVersionView = {
  version: number;
  sha256: string;
  contentType: "image/jpeg" | "image/png";
  byteSize: number;
  width: number;
  height: number;
  licence: MediaLicenceView;
  /** Staff-only photo description. Never part of an ImageRef. */
  description: string | null;
  /** Staff-only photo title (required on a v2 version). Never part of an ImageRef. */
  title: string | null;
  /** Null only for versions from before the statement existed (migration 0019). */
  rights: MediaRightsView | null;
  publishedAt: string | null;
  createdAt: string;
};

/** The private submission fields of an item (staff views only; null on the item when it has no media_submissions row). */
export type MediaSubmissionView = { fullName: string | null; instagramHandle: string | null; instagramDisplayConsent: boolean };

/** The API `MediaItem` (docs/openapi.yaml). The storage path is never part of it. */
export type MediaItemView = {
  id: string;
  state: "unverified" | "published" | "withdrawn";
  revision: number;
  draftVersion: number;
  publishedVersion: number | null;
  draft: MediaVersionView;
  submission: MediaSubmissionView | null;
  owner?: string;
  createdAt: string;
  updatedAt: string;
};

/** `med-<n>`: the wire form of the numeric media id. */
export function mediaIdOf(id: number): string {
  return `med-${id}`;
}

/** `includeOwner` adds `rights.statedBy` (a principal), for admin callers only. */
export function toVersionView(row: MediaVersionRow, includeOwner = false): MediaVersionView {
  return {
    version: row.version,
    sha256: row.sha256,
    contentType: row.contentType,
    byteSize: row.byteSize,
    width: row.width,
    height: row.height,
    licence: {
      credit: row.creditName,
      licenceName: row.licenceName,
      licenceUrl: row.licenceUrl,
      sourceUrl: row.sourceUrl,
      attributionText: row.attributionText,
      creditRequired: row.creditRequired,
    },
    description: row.description,
    title: row.title,
    rights:
      row.rightsStatement !== null && row.rightsStatedAt !== null
        ? {
            statement: row.rightsStatement,
            statedAt: row.rightsStatedAt.toISOString(),
            ...(includeOwner && row.rightsStatedBy !== null ? { statedBy: row.rightsStatedBy } : {}),
          }
        : null,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** `owner` (the uploader's principal) is shown to admin callers only. */
export function toSubmissionView(row: MediaSubmissionRow | null | undefined): MediaSubmissionView | null {
  return row ? { fullName: row.fullName, instagramHandle: row.instagramHandle, instagramDisplayConsent: row.instagramDisplayConsent } : null;
}

/** `submission` is the item's media_submissions row (or null): shown on every staff route, which already limits who sees the item. */
export function toItemView(item: MediaItemRow, draft: MediaVersionRow, includeOwner: boolean, submission: MediaSubmissionRow | null): MediaItemView {
  return {
    id: mediaIdOf(item.id),
    state: item.state,
    revision: item.revision,
    draftVersion: item.draftVersion,
    publishedVersion: item.publishedVersion,
    draft: toVersionView(draft, includeOwner),
    submission: toSubmissionView(submission),
    ...(includeOwner ? { owner: item.owner } : {}),
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}
