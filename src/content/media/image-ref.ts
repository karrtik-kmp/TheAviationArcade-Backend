import { CDN_PATH_PREFIX, signCdnUrl } from "../../platform/cdn-signer.js";
import type { CdnConfig } from "../../config/config.module.js";
import { mediaIdOf, toVersionView } from "./media-view.js";
import type { MediaLicenceView, MediaVersionRow } from "./media-view.js";

/** Signed links last 24 hours from issue (Backend ADR-0001). */
export const CDN_LINK_SECONDS = 24 * 60 * 60;

const EXTENSION = { "image/jpeg": "jpg", "image/png": "png" } as const;

/** The API `ImageRef` (docs/openapi.yaml): `url` and `expiresAt` both set, or both null with `reason`. The storage path is never part of it. */
export type ImageRefView = {
  mediaId: string;
  version: number;
  sha256: string;
  contentType: "image/jpeg" | "image/png";
  width: number;
  height: number;
  licence: MediaLicenceView;
} & ({ url: string; expiresAt: string; reason: null } | { url: null; expiresAt: null; reason: "cdn_not_configured" });

/**
 * A signed reference to one file version. `now` is the DATABASE instant (the caller reads it once); the link expires 24 h after it.
 * The path is derived from the digest here and never stored. Without a CDN config the link is null and says why.
 */
export function toImageRef(mediaId: number, row: MediaVersionRow, cdn: CdnConfig | undefined, now: Date): ImageRefView {
  const base = {
    mediaId: mediaIdOf(mediaId),
    version: row.version,
    sha256: row.sha256,
    contentType: row.contentType,
    width: row.width,
    height: row.height,
    licence: toVersionView(row).licence,
  };
  if (cdn === undefined) return { ...base, url: null, expiresAt: null, reason: "cdn_not_configured" };
  const signed = signCdnUrl({
    host: cdn.host,
    path: `${CDN_PATH_PREFIX}${row.sha256}.${EXTENSION[row.contentType]}`,
    key: cdn.tokenKey,
    expiresAt: new Date(now.getTime() + CDN_LINK_SECONDS * 1000),
    now,
  });
  return { ...base, url: signed.url, expiresAt: signed.expiresAt.toISOString(), reason: null };
}
