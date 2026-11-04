import type { MediaRightsStatement } from "../../db/enums.js";
import { mediaItems, mediaVersions } from "../../db/schema.js";

export type MediaItemRow = typeof mediaItems.$inferSelect;
export type MediaVersionRow = typeof mediaVersions.$inferSelect;

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
  /** Null only for versions from before the statement existed (migration 0019). */
  rights: MediaRightsView | null;
  publishedAt: string | null;
  createdAt: string;
};

/** The API `MediaItem` (docs/openapi.yaml). The storage path is never part of it. */
export type MediaItemView = {
  id: string;
  state: "unverified" | "published" | "withdrawn";
  revision: number;
  draftVersion: number;
  publishedVersion: number | null;
  draft: MediaVersionView;
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
export function toItemView(item: MediaItemRow, draft: MediaVersionRow, includeOwner: boolean): MediaItemView {
  return {
    id: mediaIdOf(item.id),
    state: item.state,
    revision: item.revision,
    draftVersion: item.draftVersion,
    publishedVersion: item.publishedVersion,
    draft: toVersionView(draft, includeOwner),
    ...(includeOwner ? { owner: item.owner } : {}),
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}
