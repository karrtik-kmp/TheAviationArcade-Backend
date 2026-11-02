import { Logger } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Database, DatabaseService, Tx } from "../../database/database.module.js";
import { contentDocuments, contentItems } from "../../db/schema.js";
import type { ContentDocumentRow } from "../../db/schema.js";
import { SEED_COMMERCIAL_CARD_KEYS } from "../../rules/aircraft-tags.js";
import { militaryCardKey } from "../../rules/clipper-cards.js";
import { compareIds } from "../content-modules.js";
import { canonicalBytes, sha256Hex } from "./canonical.js";
import {
  DOCUMENT_FORMAT,
  buildAircraftTagsBody,
  buildClipperCardsBody,
  buildFieldAwardsBody,
  CONTENT_DOCUMENT_NAMES,
  parseAircraftTags,
  parseClipperCards,
  parseFieldAwards,
  validateDocument,
} from "./documents.js";
import type { ContentDocumentName } from "./documents.js";

/**
 * The ONLY file that writes `content_documents` (rows are immutable; test/content-documents.test.ts keeps it so).
 * Plain functions over a Database or a transaction, like trip-store.ts.
 */
const logger = new Logger("ContentDocuments");

/** Anything with `.select()`: the pool-backed database or a transaction. */
export type Reader = Database | Tx;

export const SEED_AUTHOR = "system:seed";
const MILITARY = "aircraft-identifier-military";

/** What the manifest lists per document: no body. */
export type DocumentMeta = Pick<ContentDocumentRow, "name" | "version" | "format" | "sha256" | "byteSize" | "createdAt">;

export class DocumentIntegrityError extends Error {}

/** The served bytes of a row, checked: the canonical serialisation of the stored body must hash to the stored digest and length. */
export function verifiedBytes(row: ContentDocumentRow): Buffer {
  validateDocument(row.name, row.body, row.version);
  const bytes = canonicalBytes(row.body);
  if (bytes.length !== row.byteSize || sha256Hex(bytes) !== row.sha256) {
    throw new DocumentIntegrityError(`${row.name} v${row.version}: stored digest does not match the canonical bytes`);
  }
  return bytes;
}

const META_COLUMNS = {
  name: contentDocuments.name,
  version: contentDocuments.version,
  format: contentDocuments.format,
  sha256: contentDocuments.sha256,
  byteSize: contentDocuments.byteSize,
  createdAt: contentDocuments.createdAt,
};

/** The parsed form of a verified row, per name. */
export type ParsedDocuments = {
  "field-awards": ReturnType<typeof parseFieldAwards>;
  "aircraft-tags": ReturnType<typeof parseAircraftTags>;
  "clipper-cards": ReturnType<typeof parseClipperCards>;
};

// Rows are immutable (trigger + single writer), so a verdict for (name, version, sha256) never changes: it is computed once
// per process. A completion therefore normally does no zod, canonicalisation or SHA-256 under the player lock.
const verdicts = new Map<string, { ok: true; value: unknown } | { ok: false }>();
let validations = 0;

/** How many full validations (parse + canonical bytes + digest) ran in this process. Test hook for the memoisation. */
export function validationCount(): number {
  return validations;
}
/** Forget every memoised verdict. Test hook. */
export function resetDocumentMemo(): void {
  verdicts.clear();
}

function verify<N extends ContentDocumentName>(row: ContentDocumentRow): ParsedDocuments[N] {
  validations += 1;
  verifiedBytes(row); // shape, then the digest and length of the canonical bytes
  switch (row.name) {
    case "field-awards":
      return parseFieldAwards(row.body, row.version) as ParsedDocuments[N];
    case "aircraft-tags":
      return parseAircraftTags(row.body, row.version) as ParsedDocuments[N];
    case "clipper-cards":
      return parseClipperCards(row.body, row.version) as ParsedDocuments[N];
  }
}

export type InForce<N extends ContentDocumentName> = {
  meta: DocumentMeta;
  value: ParsedDocuments[N];
  /** How many newer rows were skipped as invalid. */
  skipped: number;
};

/**
 * THE definition of "in force" for a name: the highest version whose row is valid (shape, digest, length). Both
 * `catalogInForce` and the manifest use it, so the manifest never advertises a row that cannot be fetched. It reads one
 * metadata row at a time, newest first, and walks to an older one only when a row is invalid; the body is fetched only the
 * first time a (name, version, sha256) is seen. A bad row is logged once per (name, version, sha256). Undefined when no
 * row of the name is valid.
 */
export async function documentInForce<N extends ContentDocumentName>(db: Reader, name: N): Promise<InForce<N> | undefined> {
  for (let skipped = 0; ; skipped++) {
    const [meta] = await db
      .select(META_COLUMNS)
      .from(contentDocuments)
      .where(eq(contentDocuments.name, name))
      .orderBy(desc(contentDocuments.version))
      .limit(1)
      .offset(skipped);
    if (!meta) return undefined;
    const key = `${meta.name}/${meta.version}/${meta.sha256}`;
    let verdict = verdicts.get(key);
    if (!verdict) {
      const row = await findDocument(db, name, meta.version);
      try {
        if (!row || row.sha256 !== meta.sha256) throw new DocumentIntegrityError("row changed while it was read");
        verdict = { ok: true, value: verify(row) };
      } catch (error) {
        logger.error(`${name} v${meta.version} is not a valid document and is skipped: ${error instanceof Error ? error.message : String(error)}`);
        verdict = { ok: false };
      }
      verdicts.set(key, verdict);
    }
    if (verdict.ok) return { meta, value: verdict.value as ParsedDocuments[N], skipped };
  }
}

/** The documents the manifest lists: the in-force version of every name that has one, name ascending. */
export async function documentsInForce(db: Reader): Promise<DocumentMeta[]> {
  const out: DocumentMeta[] = [];
  for (const name of [...CONTENT_DOCUMENT_NAMES].sort()) {
    const found = await documentInForce(db, name);
    if (found) out.push(found.meta);
  }
  return out;
}

export async function anyDocument(db: Reader): Promise<boolean> {
  const [row] = await db.select({ version: contentDocuments.version }).from(contentDocuments).limit(1);
  return row !== undefined;
}

export async function findDocument(db: Reader, name: ContentDocumentName, version: number): Promise<ContentDocumentRow | undefined> {
  const [row] = await db
    .select()
    .from(contentDocuments)
    .where(and(eq(contentDocuments.name, name), eq(contentDocuments.version, version)));
  return row;
}

export type NewDocument = { name: ContentDocumentName; version: number; body: unknown; createdBy: string; note?: string };

/**
 * Inserts one immutable version. The body is validated and serialised here, so the stored digest and length are the
 * canonical bytes' by construction. An existing (name, version) is left alone: returns false. Never updates.
 */
export async function insertDocument(db: Reader, doc: NewDocument): Promise<boolean> {
  validateDocument(doc.name, doc.body, doc.version);
  const bytes = canonicalBytes(doc.body);
  const inserted = await db
    .insert(contentDocuments)
    .values({
      name: doc.name,
      version: doc.version,
      format: DOCUMENT_FORMAT[doc.name],
      body: doc.body,
      sha256: sha256Hex(bytes),
      byteSize: bytes.length,
      createdBy: doc.createdBy,
      note: doc.note ?? null,
    })
    .onConflictDoNothing()
    .returning({ name: contentDocuments.name });
  return inserted.length === 1;
}

/** Approved Military items in natural id order, with their Card key (the frozen one, else derived from the answer). */
export async function militaryCardItems(db: Reader): Promise<{ id: string; answer: string; cardKey: string }[]> {
  const rows = await db
    .select({ id: contentItems.id, data: contentItems.data, cardKey: contentItems.cardKey })
    .from(contentItems)
    .where(and(eq(contentItems.module, MILITARY), eq(contentItems.status, "approved")));
  const items: { id: string; answer: string; cardKey: string }[] = [];
  for (const row of rows.sort((a, b) => compareIds(a.id, b.id))) {
    const answer = (row.data as { answer?: unknown } | null)?.answer;
    if (typeof answer !== "string" || answer.trim() === "") continue;
    const cardKey = row.cardKey ?? militaryCardKey(answer);
    if (cardKey !== "") items.push({ id: row.id, answer, cardKey });
  }
  return items;
}

async function hasAny(tx: Tx, name: ContentDocumentName): Promise<boolean> {
  const [row] = await tx.select({ version: contentDocuments.version }).from(contentDocuments).where(eq(contentDocuments.name, name)).limit(1);
  return row !== undefined;
}

export type SeedResult = { seeded: ContentDocumentName[]; failed: ContentDocumentName[] };

const SEED_LOCK = sql`SELECT pg_advisory_xact_lock(hashtextextended('content-documents-seed', 0))`;

// The limits of the clipper-cards schema (documents.ts). An item over one is SKIPPED, never allowed to block the document.
const MAX_CARD_NAME = 500;
const MAX_CARD_KEY = 512;
const MAX_ITEM_ID = 64;
const MAX_ITEMS_PER_CARD = 1000;
const MAX_CARDS = 5000;

export type SealableItems = { accepted: { id: string; answer: string; cardKey: string }[]; skipped: { id: string; why: string }[] };

/** Splits approved Military items into those the clipper-cards schema can hold and those that exceed a limit (pure). */
export function sealableMilitaryItems(items: readonly { id: string; answer: string; cardKey: string }[], commercialCards: number): SealableItems {
  const accepted: SealableItems["accepted"] = [];
  const skipped: SealableItems["skipped"] = [];
  const perKey = new Map<string, number>();
  for (const item of items) {
    const count = perKey.get(item.cardKey) ?? 0;
    let why: string | undefined;
    if (item.id.length > MAX_ITEM_ID) why = "item id too long";
    else if (item.cardKey.length > MAX_CARD_KEY) why = "Card key too long";
    else if (count === 0 && item.answer.length > MAX_CARD_NAME) why = "answer too long for a Card name";
    else if (count >= MAX_ITEMS_PER_CARD) why = "too many items on one Card";
    else if (count === 0 && perKey.size + commercialCards >= MAX_CARDS) why = "too many Cards";
    if (why) skipped.push({ id: item.id, why });
    else {
      accepted.push(item);
      perKey.set(item.cardKey, count + 1);
    }
  }
  return { accepted, skipped };
}

/**
 * The version-1 seed (design 7; the T4 decision recorded in the design doc). Idempotent, and it can never change a stored
 * version: a name that already has ANY row is never touched, and an insert is ON CONFLICT DO NOTHING.
 *
 *  - field-awards v1 and aircraft-tags v1 are pure functions of code constants, so they are seeded whenever the name has no
 *    row, on a fresh and on an existing database alike, and come out byte-identical (test: a golden digest).
 *  - clipper-cards v1 also needs the stored Military items. A fresh database has none until the first import, and a v1 sealed
 *    without them would be commercial-only for good, so it is seeded only when the name has no row AND approved Military
 *    items exist. Two triggers call this: application boot (an existing database), and the end of a successful import
 *    (a fresh one, `ContentDocumentsService.afterImport`). After v1 exists, content changes reach the app only as a newer
 *    version (T6 publish). A v1 sealed from a small or trial set stays incomplete until a publish.
 *  - Each name is seeded in its own savepoint: one that fails (logged, reported in `failed`) rolls back alone and cannot
 *    take the others with it. An approved item over a schema limit is skipped with a warning, counted in the note.
 *
 * One transaction under a transaction-scoped advisory lock: concurrent callers (two boots, a boot and an import, two
 * instances) serialise, and the second sees the first's rows.
 */
export async function seedContentDocuments(database: Pick<DatabaseService, "withTransaction">): Promise<SeedResult> {
  return database.withTransaction(async (tx) => {
    await tx.execute(SEED_LOCK);
    const seeded: ContentDocumentName[] = [];
    const failed: ContentDocumentName[] = [];
    const seed = async (name: ContentDocumentName, build: (sp: Tx) => Promise<NewDocument | undefined>) => {
      try {
        await tx.transaction(async (sp) => {
          if (await hasAny(sp, name)) return;
          const doc = await build(sp);
          if (!doc) return;
          await insertDocument(sp, doc);
          seeded.push(name);
        });
      } catch (error) {
        failed.push(name);
        logger.error(`seeding ${name} v1 failed and was left out: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    await seed("field-awards", async () => ({
      name: "field-awards",
      version: 1,
      body: buildFieldAwardsBody(1),
      createdBy: SEED_AUTHOR,
      note: "Seed: Field Awards #1.xlsx (28 rows) on the Unity code ids, generated from src/rules.",
    }));
    await seed("aircraft-tags", async () => ({
      name: "aircraft-tags",
      version: 1,
      body: buildAircraftTagsBody(1),
      createdBy: SEED_AUTHOR,
      note: "Seed: Unity AircraftTags.cs table, provisional except the two client rulings (U8), generated from src/rules.",
    }));
    await seed("clipper-cards", async (sp) => {
      const items = await militaryCardItems(sp);
      const { accepted, skipped } = sealableMilitaryItems(items, SEED_COMMERCIAL_CARD_KEYS.size);
      for (const item of skipped) logger.warn(`clipper-cards v1: Military item ${item.id} skipped (${item.why})`);
      if (accepted.length === 0) return undefined; // nothing to seal yet (or every item over a limit)
      return {
        name: "clipper-cards",
        version: 1,
        body: buildClipperCardsBody(1, accepted),
        createdBy: SEED_AUTHOR,
        note: `Seed: commercial families plus approved Military items: ${items.length} approved, ${accepted.length} sealed, ${skipped.length} skipped (over a limit). Incomplete until a publish if the set was small or a trial.`,
      };
    });
    return { seeded, failed };
  });
}
