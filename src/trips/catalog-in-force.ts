import { SEED_AIRCRAFT_TAG_TABLE } from "../rules/aircraft-tags.js";
import type { AircraftTagTable } from "../rules/aircraft-tags.js";
import { FIELD_AWARD_CATALOG } from "../rules/field-award-catalog.js";
import type { FieldAwardDefinition } from "../rules/field-awards.js";

/**
 * The catalog `complete` judges against (design 3.6). T3 reads it from the code constants T1 seeded: the 28 awards from
 * the client's sheet and the provisional tag table (U8). Slice T4 replaces the body of `catalogInForce` with the newest
 * `content_documents` versions; the callers (trip-completion.ts) do not change. `version` is recorded on the segment and
 * on every earned award.
 */
export const SEED_CATALOG_VERSION = 1;

export type CatalogInForce = {
  version: number;
  awards: readonly FieldAwardDefinition[];
  tags: AircraftTagTable;
};

export function catalogInForce(): CatalogInForce {
  return { version: SEED_CATALOG_VERSION, awards: FIELD_AWARD_CATALOG, tags: SEED_AIRCRAFT_TAG_TABLE };
}
