import { Logger } from "@nestjs/common";
import { ApiError } from "../common/errors.js";
import { documentInForce } from "../content/documents/document-store.js";
import type { Reader } from "../content/documents/document-store.js";
import type { AircraftTagTable } from "../rules/aircraft-tags.js";
import type { FieldAwardDefinition } from "../rules/field-awards.js";

/**
 * The catalog `complete` judges against (design 3.6), read from the in-force `content_documents` versions of
 * `field-awards` and `aircraft-tags` through the caller's transaction (slice T4; before it this was a code constant).
 * "In force" is `documentInForce`: the highest VALID version (shape, digest and length), the same selection the manifest
 * lists, so the manifest never advertises a catalog this function would not use. Verdicts are memoised per
 * (name, version, sha256), so a completion normally runs no validation under the player lock.
 *
 * `version` is the FIELD-AWARDS document's version: it is recorded on the segment and on every earned award, so it names
 * the targets and text the award was judged against. The tag document's version is not recorded (one column). With no
 * valid row of either name (the seed has not run yet) this answers 503 `service_unavailable` with `Retry-After`: retryable,
 * never a silent default.
 */
export type CatalogInForce = {
  version: number;
  /** The aircraft-tags document's version applied (not recorded on a segment; the Logbook ETag folds it in, T5). */
  tagsVersion: number;
  awards: readonly FieldAwardDefinition[];
  tags: AircraftTagTable;
};

const logger = new Logger("CatalogInForce");
const loggedPairs = new Set<string>();

export async function catalogInForce(db: Reader): Promise<CatalogInForce> {
  const awards = await documentInForce(db, "field-awards");
  const tags = await documentInForce(db, "aircraft-tags");
  if (!awards || !tags) {
    throw new ApiError(503, "service_unavailable", "Content is not ready yet. Retry shortly.", { "Retry-After": "5" });
  }
  if (awards.skipped > 0 || tags.skipped > 0) {
    // One of the two fell back past an invalid newer row: say which pair is applied, once per pair.
    const pair = `${awards.meta.version}/${tags.meta.version}`;
    if (!loggedPairs.has(pair)) {
      loggedPairs.add(pair);
      logger.warn(
        `catalog in force: field-awards v${awards.meta.version} (${awards.skipped} newer skipped), aircraft-tags v${tags.meta.version} (${tags.skipped} newer skipped)`,
      );
    }
  }
  return { version: awards.meta.version, tagsVersion: tags.meta.version, awards: awards.value.awards, tags: tags.value.tags };
}
