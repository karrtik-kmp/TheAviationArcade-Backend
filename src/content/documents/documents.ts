import { z } from "zod";
import { CONTENT_DOCUMENT_NAMES } from "../../db/enums.js";
import type { ContentDocumentName } from "../../db/enums.js";
import {
  AIRCRAFT_TAGS,
  SEED_AIRCRAFT_TAG_ENTRIES,
  SEED_COMMERCIAL_CARD_KEYS,
  buildTagTable,
} from "../../rules/aircraft-tags.js";
import type { AircraftTagEntry, AircraftTagTable } from "../../rules/aircraft-tags.js";
import { CARD_MODULES, cardKeySource } from "../../rules/clipper-cards.js";
import { FIELD_AWARD_CATALOG, FIELD_AWARD_CATALOG_SOURCE } from "../../rules/field-award-catalog.js";
import { FIELD_AWARD_IDS, FIELD_AWARD_METRICS } from "../../rules/field-awards.js";
import type { FieldAwardDefinition, FieldAwardMetric } from "../../rules/field-awards.js";

/**
 * The three published documents (design 7; openapi `FieldAwardCatalogDocument`, `ClipperCardCatalogDocument`,
 * `AircraftTagDocument`): their builders (the v1 seed is GENERATED from the code constants and the stored Military content,
 * never typed by hand) and the validators that protect `catalogInForce` from a bad row. The bytes are `canonicalBytes` of the
 * body (canonical.ts).
 */
export { CONTENT_DOCUMENT_NAMES };
export type { ContentDocumentName };

export const DOCUMENT_FORMAT: Readonly<Record<ContentDocumentName, string>> = {
  "field-awards": "field-awards.v1",
  "clipper-cards": "clipper-cards.v1",
  "aircraft-tags": "aircraft-tags.v1",
};

export function isDocumentName(value: string): value is ContentDocumentName {
  return (CONTENT_DOCUMENT_NAMES as readonly string[]).includes(value);
}

export class DocumentValidationError extends Error {}

/** The metrics that read aircraft tags (authored by us, J5): their awards are the `provisional` ones. */
const TAG_METRICS: ReadonlySet<FieldAwardMetric> = new Set<FieldAwardMetric>([
  "quad-engine-cards",
  "rivalry-balance",
  "heavy-cards",
  "regional-cards",
  "quick-fighter-id",
  "fighter-aces",
  "rotary-identified",
  "vtol-identified",
]);

// ---------------------------------------------------------------------------------------------------------------
// field-awards

const SHA256 = /^[0-9a-f]{64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Targets are whole numbers in 1..1e9: a bigger one is a typo, not a goal (and the evaluator would accept it). */
export const MAX_TARGET = 1_000_000_000;

const rulingSchema = z.strictObject({
  field: z.string(),
  text: z.string(),
  source: z.string(),
  status: z.enum(["confirmed", "resolved", "to-confirm"]),
});

const awardSchema = z.strictObject({
  id: z.enum(FIELD_AWARD_IDS),
  sheetId: z.string().min(1).max(200),
  sheetRow: z.number().int().min(2).max(10_000),
  title: z.string().min(1).max(200),
  criteria: z.string().min(1).max(2000),
  thresholdCell: z.string().max(200),
  target: z.number().int().min(1).max(MAX_TARGET),
  metric: z.enum(FIELD_AWARD_METRICS),
  hidden: z.boolean(),
  rulings: z.array(rulingSchema).max(50),
});

const fieldAwardsSchema = z.strictObject({
  format: z.literal(DOCUMENT_FORMAT["field-awards"]),
  version: z.number().int().min(1),
  source: z.strictObject({
    file: z.string().min(1).max(200),
    sha256: z.string().regex(SHA256),
    importDate: z.string().regex(ISO_DATE),
  }),
  awards: z.array(awardSchema).length(FIELD_AWARD_IDS.length),
});

/** The metric of an award is code, not content (design 8: staff never edit it): it must be the id's own metric. */
const METRIC_OF: ReadonlyMap<string, FieldAwardMetric> = new Map(FIELD_AWARD_CATALOG.map((d) => [d.id, d.metric]));

export type FieldAwardsDocument = z.infer<typeof fieldAwardsSchema>;

function issues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join(".") || "$"}: ${i.message}`)
    .join("; ");
}

function checkVersion(found: number, expected: number | undefined, name: string): void {
  if (expected !== undefined && found !== expected) {
    throw new DocumentValidationError(`${name}: body version ${found} differs from the row version ${expected}`);
  }
}

/**
 * Validates a stored or about-to-be-stored field-awards body and returns it as the definitions `evaluateFieldAwards` takes.
 * Throws DocumentValidationError. Rules beyond the shape: each of the 28 ids exactly once; each award's metric is its
 * id's own metric; the body's `version` equals the row's.
 */
export function parseFieldAwards(body: unknown, expectedVersion?: number): { version: number; awards: FieldAwardDefinition[] } {
  const parsed = fieldAwardsSchema.safeParse(body);
  if (!parsed.success) throw new DocumentValidationError(`field-awards: ${issues(parsed.error)}`);
  const doc = parsed.data;
  checkVersion(doc.version, expectedVersion, "field-awards");
  const seen = new Set<string>();
  for (const award of doc.awards) {
    if (seen.has(award.id)) throw new DocumentValidationError(`field-awards: ${award.id} appears twice`);
    seen.add(award.id);
    if (METRIC_OF.get(award.id) !== award.metric) {
      throw new DocumentValidationError(`field-awards: ${award.id} has metric ${award.metric}, which is not its metric`);
    }
  }
  if (seen.size !== FIELD_AWARD_IDS.length) throw new DocumentValidationError("field-awards: not all 28 awards are listed");
  return {
    version: doc.version,
    awards: doc.awards.map((a) => ({ ...a, provisional: TAG_METRICS.has(a.metric) })),
  };
}

/** Version `version` of the Field Award catalog, from the code constants (the sheet snapshot, T1). */
export function buildFieldAwardsBody(version: number): Record<string, unknown> {
  return {
    format: DOCUMENT_FORMAT["field-awards"],
    version,
    source: { ...FIELD_AWARD_CATALOG_SOURCE },
    // `provisional` is derived from the metric, so it is not part of the published definition.
    awards: FIELD_AWARD_CATALOG.map(({ provisional: _provisional, ...definition }) => ({
      ...definition,
      rulings: definition.rulings.map((r) => ({ ...r })),
    })),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// aircraft-tags

const tagSourceSchema = z.enum(["client_sheet", "client_ruling", "provisional"]);

const tagEntrySchema = z.strictObject({
  cardKey: z.string().min(1).max(512),
  manufacturer: z.string().min(1).max(200).nullable(),
  manufacturerSource: tagSourceSchema.nullable(),
  tags: z
    .array(z.strictObject({ tag: z.enum(AIRCRAFT_TAGS), source: tagSourceSchema }))
    .max(AIRCRAFT_TAGS.length),
});

const aircraftTagsSchema = z.strictObject({
  format: z.literal(DOCUMENT_FORMAT["aircraft-tags"]),
  version: z.number().int().min(1),
  entries: z.array(tagEntrySchema).min(1).max(5000),
});

/** Validates an aircraft-tags body and returns the lookup table the evaluator reads. One entry per Card key; a tag at most once per entry. */
export function parseAircraftTags(body: unknown, expectedVersion?: number): { version: number; tags: AircraftTagTable } {
  const parsed = aircraftTagsSchema.safeParse(body);
  if (!parsed.success) throw new DocumentValidationError(`aircraft-tags: ${issues(parsed.error)}`);
  const doc = parsed.data;
  checkVersion(doc.version, expectedVersion, "aircraft-tags");
  const keys = new Set<string>();
  for (const entry of doc.entries) {
    if (keys.has(entry.cardKey)) throw new DocumentValidationError(`aircraft-tags: ${entry.cardKey} appears twice`);
    keys.add(entry.cardKey);
    if (new Set(entry.tags.map((t) => t.tag)).size !== entry.tags.length) {
      throw new DocumentValidationError(`aircraft-tags: ${entry.cardKey} repeats a tag`);
    }
  }
  const entries: AircraftTagEntry[] = doc.entries.map((e) => ({ ...e, tags: e.tags.map((t) => ({ ...t })) }));
  return { version: doc.version, tags: buildTagTable(entries) };
}

/** Version `version` of the tag document, from the seed table (Unity AircraftTags.cs, provisional except the two client rulings). */
export function buildAircraftTagsBody(version: number): Record<string, unknown> {
  return {
    format: DOCUMENT_FORMAT["aircraft-tags"],
    version,
    entries: SEED_AIRCRAFT_TAG_ENTRIES.map((e) => ({
      cardKey: e.cardKey,
      manufacturer: e.manufacturer,
      manufacturerSource: e.manufacturerSource,
      tags: e.tags.map((t) => ({ tag: t.tag, source: t.source })),
    })),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// clipper-cards

const clipperCardsSchema = z.strictObject({
  format: z.literal(DOCUMENT_FORMAT["clipper-cards"]),
  version: z.number().int().min(1),
  cards: z
    .array(
      z.strictObject({
        key: z.string().min(1).max(512),
        module: z.enum(CARD_MODULES),
        name: z.string().min(1).max(500),
        keySource: z.enum(["unity_family", "client_answer_text"]),
        itemIds: z.array(z.string().min(1).max(64)).max(1000),
      }),
    )
    .max(5000),
});

export function parseClipperCards(body: unknown, expectedVersion?: number): { version: number } {
  const parsed = clipperCardsSchema.safeParse(body);
  if (!parsed.success) throw new DocumentValidationError(`clipper-cards: ${issues(parsed.error)}`);
  checkVersion(parsed.data.version, expectedVersion, "clipper-cards");
  const keys = new Set<string>();
  for (const card of parsed.data.cards) {
    if (keys.has(card.key)) throw new DocumentValidationError(`clipper-cards: ${card.key} appears twice`);
    keys.add(card.key);
    if (card.keySource !== cardKeySource(card.module)) {
      throw new DocumentValidationError(`clipper-cards: ${card.key} has a keySource that does not fit module ${card.module}`);
    }
  }
  return { version: parsed.data.version };
}

/** A Military content item as the Card catalog reads it. `cardKey` is the frozen key, or null for a row older than 0009. */
export type MilitaryCardItem = { id: string; answer: string; cardKey: string | null };

/**
 * Version `version` of the Clipper Card catalog: the seeded commercial families (in their seed order, `name` = the family,
 * `itemIds` empty until the Identifier importer exists, D-2), then one Card per distinct Military Card key, in the natural id
 * order of the first item that holds it. `name` = that first item's answer text as the client supplied it; `itemIds` = every
 * item holding the key. `militaryItems` must already be in natural id order and carry a non-empty key (the caller derives it).
 */
export function buildClipperCardsBody(
  version: number,
  militaryItems: readonly { id: string; answer: string; cardKey: string }[],
): Record<string, unknown> {
  const commercial = [...SEED_COMMERCIAL_CARD_KEYS].map((family) => ({
    key: family,
    module: "identifier" as const,
    name: family,
    keySource: cardKeySource("identifier"),
    itemIds: [] as string[],
  }));
  const military = new Map<string, { key: string; module: "aircraft-identifier-military"; name: string; keySource: string; itemIds: string[] }>();
  for (const item of militaryItems) {
    const card = military.get(item.cardKey);
    if (card) card.itemIds.push(item.id);
    else {
      military.set(item.cardKey, {
        key: item.cardKey,
        module: "aircraft-identifier-military",
        name: item.answer,
        keySource: cardKeySource("aircraft-identifier-military"),
        itemIds: [item.id],
      });
    }
  }
  return { format: DOCUMENT_FORMAT["clipper-cards"], version, cards: [...commercial, ...military.values()] };
}

/** Validates a body for its name. Used before any insert and when a row is read for serving. */
export function validateDocument(name: ContentDocumentName, body: unknown, expectedVersion?: number): void {
  switch (name) {
    case "field-awards":
      parseFieldAwards(body, expectedVersion);
      return;
    case "aircraft-tags":
      parseAircraftTags(body, expectedVersion);
      return;
    case "clipper-cards":
      parseClipperCards(body, expectedVersion);
      return;
  }
}
