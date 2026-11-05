import type { CdnConfig } from "../../config/config.module.js";
import type { EditorialItemRow } from "../../db/schema.js";
import { toImageRef } from "../media/image-ref.js";
import type { ImageRefView } from "../media/image-ref.js";
import { mediaIdOf } from "../media/media-view.js";
import type { MediaVersionRow } from "../media/media-view.js";
import { formatEditorialId } from "./editorial-rules.js";
import type { EditorialData } from "./editorial-rules.js";

/** The API `EditorialItem` (docs/openapi.yaml). Staff only; no principal is part of it. */
export type EditorialItemView = {
  id: string;
  kind: EditorialItemRow["kind"];
  mediaId: string;
  status: EditorialItemRow["status"];
  dateKey: string | null;
  version: number;
  data: EditorialData;
  createdAt: string;
  updatedAt: string;
};

export function toEditorialView(row: EditorialItemRow): EditorialItemView {
  return {
    id: formatEditorialId(row.id),
    kind: row.kind,
    mediaId: mediaIdOf(row.mediaId),
    status: row.status,
    dateKey: row.dateKey,
    version: row.version,
    data: row.data as EditorialData,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The API `PublicFeature`. Every field is named here, so nothing else can leak: no staff-typed `credit` (the one public
 * attribution is `image.licence.credit`, frozen on the published media version), no answer, distractor, difficulty, source,
 * status, version, owner or rights.
 */
export type PublicFeatureView = {
  id: string;
  date: string;
  title: string;
  aircraft: string;
  photographer: string;
  instagram: string;
  description: string;
  image: ImageRefView;
};

/** `version` is the media's PUBLISHED version row (the caller has already checked it is published and has a credit). */
export function toPublicFeature(row: EditorialItemRow, version: MediaVersionRow, cdn: CdnConfig | undefined, now: Date): PublicFeatureView {
  const data = row.data as EditorialData;
  if (row.dateKey === null) throw new Error("A public feature needs a date.");
  return {
    id: formatEditorialId(row.id),
    date: row.dateKey,
    title: data.title,
    aircraft: data.aircraft,
    photographer: data.photographer,
    instagram: data.instagram,
    description: data.description,
    image: toImageRef(row.mediaId, version, cdn, now),
  };
}
