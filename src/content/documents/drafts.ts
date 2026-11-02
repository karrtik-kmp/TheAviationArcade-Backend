import { z } from "zod";
import type { ContentDocumentName } from "../../db/enums.js";
import { AIRCRAFT_TAGS } from "../../rules/aircraft-tags.js";
import type { AircraftTag } from "../../rules/aircraft-tags.js";
import { FIELD_AWARD_IDS } from "../../rules/field-awards.js";
import { canonicalJson } from "./canonical.js";
import { MAX_TARGET } from "./documents.js";

/**
 * Staff edits to the published documents (slice T6, design 8). Pure: request and stored-overlay schemas, merging, applying an
 * overlay to a document body, and describing a change. The database side is draft-store.ts and content-admin.service.ts.
 *
 * A draft is an OVERLAY on the document in force, not a copy: a draft therefore never goes stale against a newer version, and the
 * published bytes are never touched (publishing inserts a new immutable version built from base + overlay).
 *   field-awards:   edits.awards[id] = { title?, criteria?, target?, hidden? }   (never id, metric, sheet text or rulings)
 *   clipper-cards:  edits.names[cardKey] = name                                   (membership is derived from the content)
 *   aircraft-tags:  edits.tags[cardKey] = tag list (the whole list)
 */

/** A request carries at most this many edits (the global JSON limit is 16 KB). */
export const MAX_EDITS_PER_REQUEST = 25;
/** The change list in a view or an audit row is cut here; `changeCount` is the true number. */
export const MAX_LISTED_CHANGES = 200;

// Text that canonicalBytes or jsonb could not hold: U+0000 and lone surrogates (the body parser accepts both).
const UNREPRESENTABLE = /\u0000|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !UNREPRESENTABLE.test(value), "contains U+0000 or an unpaired surrogate");

const draftVersion = z.number().int().min(0).max(2_000_000_000);
const cardKey = z.string().min(1).max(512).refine((value) => !UNREPRESENTABLE.test(value));

function distinct<T>(values: readonly T[]): boolean {
  return new Set(values).size === values.length;
}

const awardEdit = z
  .strictObject({
    id: z.enum(FIELD_AWARD_IDS),
    title: text(200).optional(),
    criteria: text(2000).optional(),
    target: z.number().int().min(1).max(MAX_TARGET).optional(),
    hidden: z.boolean().optional(),
  })
  .refine((edit) => edit.title !== undefined || edit.criteria !== undefined || edit.target !== undefined || edit.hidden !== undefined, {
    message: "name at least one of title, criteria, target, hidden",
  });

export const fieldAwardsEditRequest = z
  .strictObject({ draftVersion, awards: z.array(awardEdit).min(1).max(FIELD_AWARD_IDS.length) })
  .refine((body) => distinct(body.awards.map((a) => a.id)), { message: "an award is named twice" });

export const clipperCardsEditRequest = z
  .strictObject({
    draftVersion,
    names: z.array(z.strictObject({ key: cardKey, name: text(500) })).min(1).max(MAX_EDITS_PER_REQUEST),
  })
  .refine((body) => distinct(body.names.map((n) => n.key)), { message: "a Card is named twice" });

export const aircraftTagsEditRequest = z
  .strictObject({
    draftVersion,
    entries: z
      .array(
        z.strictObject({
          cardKey,
          tags: z.array(z.enum(AIRCRAFT_TAGS)).max(AIRCRAFT_TAGS.length).refine(distinct, { message: "a tag is listed twice" }),
          // Removing a tag the client supplied (source client_sheet or client_ruling) must be acknowledged explicitly.
          acknowledgeClientTagRemoval: z.literal(true).optional(),
        }),
      )
      .min(1)
      .max(MAX_EDITS_PER_REQUEST),
  })
  .refine((body) => distinct(body.entries.map((e) => e.cardKey)), { message: "a Card is named twice" });

export const EDIT_REQUESTS = {
  "field-awards": fieldAwardsEditRequest,
  "clipper-cards": clipperCardsEditRequest,
  "aircraft-tags": aircraftTagsEditRequest,
} as const;

export const versionOnlyRequest = z.strictObject({ draftVersion });
// `acknowledgeCardRemoval`: a clipper-cards publish that drops a Card (its items were retired) must say so. Recorded in the audit row.
export const publishRequest = z.strictObject({ draftVersion, note: text(300).optional(), acknowledgeCardRemoval: z.literal(true).optional() });

/** Who touched the draft since the last publish, oldest first. Kept across a discard; copied into the publish audit row. */
const MAX_HISTORY = 1000;
const historyEntry = z.strictObject({
  principal: z.string().min(1).max(256),
  action: z.enum(["edit", "discard"]),
  at: z.string().max(40),
  draftVersion: z.number().int().min(1),
});
const history = z.array(historyEntry).max(MAX_HISTORY).optional();
export type HistoryEntry = z.infer<typeof historyEntry>;

// What is stored in content_drafts.edits. Parsed again on every read, so a hand-edited row cannot reach a published document.
const storedAward = z.strictObject({
  title: text(200).optional(),
  criteria: text(2000).optional(),
  target: z.number().int().min(1).max(MAX_TARGET).optional(),
  hidden: z.boolean().optional(),
});
export const STORED_EDITS = {
  "field-awards": z.strictObject({ awards: z.partialRecord(z.enum(FIELD_AWARD_IDS), storedAward).optional(), history }),
  "clipper-cards": z.strictObject({ names: z.record(cardKey, text(500)).optional(), history }),
  "aircraft-tags": z.strictObject({ tags: z.record(cardKey, z.array(z.enum(AIRCRAFT_TAGS)).refine(distinct)).optional(), ackClientTagRemoval: z.record(cardKey, z.literal(true)).optional(), history }),
} as const;

export type DraftEdits = {
  awards?: Record<string, { title?: string; criteria?: string; target?: number; hidden?: boolean }>;
  names?: Record<string, string>;
  tags?: Record<string, AircraftTag[]>;
  /** aircraft-tags: Card keys whose edit was acknowledged to remove a client-supplied tag. */
  ackClientTagRemoval?: Record<string, true>;
  history?: HistoryEntry[];
};

/** The overlay with one more history entry (the newest 1000 are kept). */
export function withHistory(edits: DraftEdits, principal: string, action: "edit" | "discard", draftVersion: number, at: Date): DraftEdits {
  const entry: HistoryEntry = { principal, action, at: at.toISOString(), draftVersion };
  return { ...edits, history: [...(edits.history ?? []), entry].slice(-MAX_HISTORY) };
}

/** The history of a stored overlay, even when the rest of it no longer validates (discard must keep who edited). */
export function salvageHistory(raw: unknown): HistoryEntry[] {
  const parsed = history.safeParse((raw as { history?: unknown } | null | undefined)?.history);
  return parsed.success ? (parsed.data ?? []) : [];
}

/** The principals in a history, first appearance order. */
export function editorsOf(edits: DraftEdits): string[] {
  return [...new Set((edits.history ?? []).map((h) => h.principal))];
}

/** Tags a staff edit would remove that the client supplied (source other than `provisional`), per Card key, without an acknowledgement. */
export function unacknowledgedClientRemovals(base: unknown, edits: DraftEdits): { key: string; tags: string[] }[] {
  const out: { key: string; tags: string[] }[] = [];
  const entries = ((base as Body | undefined)?.["entries"] as Body[] | undefined) ?? [];
  for (const entry of entries) {
    const wanted = edits.tags?.[entry["cardKey"]];
    if (!wanted) continue;
    const removed = removedClientTags(entry, wanted);
    if (removed.length && !edits.ackClientTagRemoval?.[entry["cardKey"]]) out.push({ key: entry["cardKey"], tags: removed });
  }
  return out;
}

function removedClientTags(entry: Body | undefined, wanted: readonly string[]): string[] {
  return ((entry?.["tags"] as Body[] | undefined) ?? []).filter((t) => t["source"] !== "provisional" && !wanted.includes(t["tag"])).map((t) => t["tag"] as string);
}

export function parseStoredEdits(name: ContentDocumentName, value: unknown): DraftEdits {
  return STORED_EDITS[name].parse(value) as DraftEdits;
}

/** The stored overlay with a validated request merged in (a later value for the same award field or Card wins). */
export function mergeEdits(name: ContentDocumentName, stored: DraftEdits, request: unknown): DraftEdits {
  switch (name) {
    case "field-awards": {
      const awards = { ...(stored.awards ?? {}) };
      for (const { id, ...fields } of (request as z.infer<typeof fieldAwardsEditRequest>).awards) {
        const defined = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
        awards[id] = { ...(awards[id] ?? {}), ...defined };
      }
      return { ...stored, awards };
    }
    case "clipper-cards": {
      const names = { ...(stored.names ?? {}) };
      for (const { key, name: label } of (request as z.infer<typeof clipperCardsEditRequest>).names) names[key] = label;
      return { ...stored, names };
    }
    case "aircraft-tags": {
      const tags = { ...(stored.tags ?? {}) };
      const ack = { ...(stored.ackClientTagRemoval ?? {}) };
      for (const entry of (request as z.infer<typeof aircraftTagsEditRequest>).entries) {
        tags[entry.cardKey] = [...entry.tags];
        // An acknowledgement belongs to one edit of one Card: a later edit of it without one asks again.
        if (entry.acknowledgeClientTagRemoval) ack[entry.cardKey] = true;
        else delete ack[entry.cardKey];
      }
      return { ...stored, tags, ackClientTagRemoval: ack };
    }
  }
}

type Body = Record<string, any>;

/** field-awards: the base body with the overlay's fields set. Pure; the base is not mutated. */
export function applyFieldAwardEdits(base: unknown, edits: DraftEdits): Body {
  const body = structuredClone(base) as Body;
  for (const award of body["awards"] as Body[]) {
    const edit = edits.awards?.[award["id"]];
    if (!edit) continue;
    for (const field of ["title", "criteria", "target", "hidden"] as const) {
      if (edit[field] !== undefined) award[field] = edit[field];
    }
  }
  return body;
}

/**
 * aircraft-tags: the base body with the overlay's tag lists. A tag already on the entry keeps its source; a tag staff add is
 * `provisional` (ASSUMPTION: it is neither the client's sheet nor a client ruling). An entry for a Card key not in the base is
 * appended (keys sorted, so the result does not depend on the order edits were made in) with no manufacturer.
 */
export function applyTagEdits(base: unknown, edits: DraftEdits): Body {
  const body = structuredClone(base) as Body;
  const entries = body["entries"] as Body[];
  const wanted = edits.tags ?? {};
  for (const entry of entries) {
    const list = wanted[entry["cardKey"]];
    if (!list) continue;
    const before = new Map<string, string>((entry["tags"] as Body[]).map((t) => [t["tag"], t["source"]]));
    if (before.size === list.length && list.every((tag) => before.has(tag))) continue; // the same set: keep the entry (order and sources) as it is
    entry["tags"] = list.map((tag) => ({ tag, source: before.get(tag) ?? "provisional" }));
  }
  const known = new Set(entries.map((e) => e["cardKey"]));
  for (const key of Object.keys(wanted).filter((k) => !known.has(k)).sort()) {
    entries.push({ cardKey: key, manufacturer: null, manufacturerSource: null, tags: (wanted[key] ?? []).map((tag) => ({ tag, source: "provisional" })) });
  }
  return body;
}

/** clipper-cards: `derived` is the document rebuilt from the current content; names come from the overlay, else the published Card, else the content. */
export function applyCardNames(derived: Body, published: unknown, edits: DraftEdits): Body {
  const body = structuredClone(derived) as Body;
  const before = new Map<string, string>(((published as Body | undefined)?.["cards"] as Body[] | undefined ?? []).map((c) => [c["key"], c["name"]]));
  for (const card of body["cards"] as Body[]) {
    card["name"] = edits.names?.[card["key"]] ?? before.get(card["key"]) ?? card["name"];
  }
  return body;
}

export function withVersion(body: Body, version: number): Body {
  return { ...body, version };
}

/** True when two bodies are the same document apart from `version`. */
export function sameContent(a: Body, b: Body): boolean {
  return canonicalJson(withVersion(a, 0)) === canonicalJson(withVersion(b, 0));
}

export type Change = { kind: string; key: string; field?: string; from?: unknown; to?: unknown; removedClientTags?: string[]; acknowledgedRemoval?: true };

/** What a publish (or the pending draft) changes, in document order. `before` undefined = nothing published yet. */
export function describeChanges(name: ContentDocumentName, before: unknown, after: unknown, edits: DraftEdits = {}): Change[] {
  const a = before as Body | undefined;
  const b = after as Body;
  const out: Change[] = [];
  switch (name) {
    case "field-awards": {
      const old = new Map<string, Body>(((a?.["awards"] as Body[] | undefined) ?? []).map((x) => [x["id"], x]));
      for (const award of b["awards"] as Body[]) {
        for (const field of ["title", "criteria", "target", "hidden"] as const) {
          const was = old.get(award["id"])?.[field];
          if (canonicalJson({ v: was ?? null }) !== canonicalJson({ v: award[field] })) {
            out.push({ kind: "award", key: award["id"], field, from: was ?? null, to: award[field] });
          }
        }
      }
      return out;
    }
    case "clipper-cards": {
      const old = new Map<string, Body>(((a?.["cards"] as Body[] | undefined) ?? []).map((x) => [x["key"], x]));
      const now = new Set<string>();
      for (const card of b["cards"] as Body[]) {
        now.add(card["key"]);
        const was = old.get(card["key"]);
        if (!was) out.push({ kind: "card-added", key: card["key"], to: card["name"] });
        else {
          if (was["name"] !== card["name"]) out.push({ kind: "card-renamed", key: card["key"], field: "name", from: was["name"], to: card["name"] });
          if (canonicalJson(was["itemIds"]) !== canonicalJson(card["itemIds"])) out.push({ kind: "card-items", key: card["key"], field: "itemIds", from: was["itemIds"], to: card["itemIds"] });
        }
      }
      for (const [key, card] of old) if (!now.has(key)) out.push({ kind: "card-removed", key, from: card["name"] });
      return out;
    }
    case "aircraft-tags": {
      const old = new Map<string, Body>(((a?.["entries"] as Body[] | undefined) ?? []).map((x) => [x["cardKey"], x]));
      const tagsOf = (entry: Body | undefined) => ((entry?.["tags"] as Body[] | undefined) ?? []).map((t) => t["tag"] as string).sort();
      for (const entry of b["entries"] as Body[]) {
        const was = old.get(entry["cardKey"]);
        const from = tagsOf(was);
        const to = tagsOf(entry);
        if (canonicalJson(from) !== canonicalJson(to)) {
          const removed = removedClientTags(was, to);
          out.push({
            kind: "tags",
            key: entry["cardKey"],
            from,
            to,
            ...(removed.length ? { removedClientTags: removed, ...(edits.ackClientTagRemoval?.[entry["cardKey"]] ? { acknowledgedRemoval: true as const } : {}) } : {}),
          });
        }
      }
      return out;
    }
  }
}
