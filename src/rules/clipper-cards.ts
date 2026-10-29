import type { ModuleId } from "./modules.js";

/**
 * Clipper Card identity (contract round 2 (4); design 3.5).
 *   - Commercial (`identifier`): the Unity aircraft family from identifier_questions.json (`787`, `A320`), used as is,
 *     and it must be a key of the seeded commercial Card catalog (`cardKeyFor`, design 3.2 rule): case variants and
 *     unknown families never create a second Card.
 *   - Military (`aircraft-identifier-military`): `mil:` + the client's answer text, normalised (`normalizeAnswerText`,
 *     ASSUMPTION A14). The `mil:` namespace keeps a Military key from ever equalling a commercial family key (A20).
 *     Repeated rows of one answer (Eurofighter Typhoon x3) share one Card; variants (the three C-130 answers) stay
 *     separate until the client supplies a family mapping (J2). The T2/T3 import computes the key once and FREEZES it
 *     on the content item (design 3.5), so a later text edit keeps the Card.
 * Only these two modules have Cards. Any other module's `aircraftKey` is null.
 */
export const CARD_MODULES = ["identifier", "aircraft-identifier-military"] as const satisfies readonly ModuleId[];
export type CardModule = (typeof CARD_MODULES)[number];

/** Namespace of every Military Card key. */
export const MILITARY_KEY_PREFIX = "mil:";

export type CardKeySource = "unity_family" | "client_answer_text";

export function isCardModule(module: ModuleId): module is CardModule {
  return module === "identifier" || module === "aircraft-identifier-military";
}

/** Dash variants folded to `-`: U+2010..U+2015, U+2212 minus, U+FE58, U+FE63, U+FF0D. */
const DASHES = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/gu;
/** Every Unicode White_Space character: JS `\s` plus U+0085 (NEL), which `\s` lacks. */
const SPACE_RUN = /[\s\u0085]+/gu;

/**
 * Card-key text normalisation (ASSUMPTION A14): NFC; drop Unicode format characters (category Cf: U+200B zero-width
 * space, U+00AD soft hyphen, U+FEFF, joiners); fold dash variants to `-`; NFC again; every run of Unicode whitespace
 * (NBSP, ideographic space, line separator, NEL) becomes one space; spaces around `/` are removed; trim; simple
 * `toLowerCase` (no full case folding: `ß` stays); NFC. Punctuation is otherwise kept.
 */
export function normalizeAnswerText(answer: string): string {
  return answer
    .normalize("NFC")
    .replace(/\p{Cf}/gu, "")
    .replace(DASHES, "-")
    .normalize("NFC")
    .replace(SPACE_RUN, " ")
    .replace(/ ?\/ ?/g, "/")
    .trim()
    .toLowerCase()
    .normalize("NFC");
}

/** The Military Card key for a client answer: `mil:` + the normalised text. Empty when the answer has no content. */
export function militaryCardKey(answer: string): string {
  const text = normalizeAnswerText(answer);
  return text.length > 0 ? `${MILITARY_KEY_PREFIX}${text}` : "";
}

/** The commercial Card key: the Unity family, trimmed. Case is kept (`A320`), as the family ids are. */
export function commercialCardKey(family: string): string {
  return family.trim();
}

/** What a Round's aircraft value means for Cards (design 3.2 rule). */
export type CardKeyResult =
  | { kind: "card"; key: string }
  | { kind: "no_card" }
  | { kind: "unknown_aircraft"; value: string };

/**
 * The Card key for a Round's aircraft value in a module. `no_card`: the module has no Cards, or the value is missing
 * or empty. A commercial value must be an exact key of `commercialCatalog` (the seeded commercial Card catalog, U9);
 * otherwise `unknown_aircraft`, which T2/T3 map to 400 `invalid_request`, so a case variant (`a320`) or a typo can
 * never create a second Card. The Military value is the client's answer text from the stored item (design 3.2); T2/T3
 * pass the key frozen on the item instead of re-deriving it.
 */
export function cardKeyFor(
  module: ModuleId,
  value: string | null | undefined,
  commercialCatalog: ReadonlySet<string>,
): CardKeyResult {
  if (value == null || !isCardModule(module)) return { kind: "no_card" };
  if (module === "identifier") {
    const key = commercialCardKey(value);
    if (key.length === 0) return { kind: "no_card" };
    return commercialCatalog.has(key) ? { kind: "card", key } : { kind: "unknown_aircraft", value };
  }
  const key = militaryCardKey(value);
  return key.length > 0 ? { kind: "card", key } : { kind: "no_card" };
}

export function cardKeySource(module: CardModule): CardKeySource {
  return module === "identifier" ? "unity_family" : "client_answer_text";
}

/** What `player_clipper_cards` keeps per Card (design 3.5 and 4). */
export type CardRecord = {
  key: string;
  module: CardModule;
  timesIdentified: number;
  /** Identified at least once with no error and no hint; a one-way latch. */
  everPerfect: boolean;
  /** Identified at least once finished without a hint; a one-way latch. */
  everHintFree: boolean;
  /** Fastest correct identification in ms, or null when none is recorded. */
  fastestCorrectMs: number | null;
};

/** One finished Round that identified an aircraft. */
export type CardSighting = {
  perfect: boolean;
  hintUsed: boolean;
  answerMs: number | null;
};

/**
 * Applies one finished Round to a Card: `existing` null = the first sighting (the Card is collected).
 * `collected` is true exactly then. Latches never clear; the fastest time only falls.
 */
export function recordSighting(
  existing: CardRecord | null,
  key: string,
  module: CardModule,
  sighting: CardSighting,
): { card: CardRecord; collected: boolean } {
  const ms = sighting.answerMs;
  const prevFastest = existing?.fastestCorrectMs ?? null;
  const fastest = ms === null ? prevFastest : prevFastest === null ? ms : Math.min(prevFastest, ms);
  return {
    collected: existing === null,
    card: {
      key,
      module,
      timesIdentified: (existing?.timesIdentified ?? 0) + 1,
      everPerfect: (existing?.everPerfect ?? false) || sighting.perfect,
      everHintFree: (existing?.everHintFree ?? false) || !sighting.hintUsed,
      fastestCorrectMs: fastest,
    },
  };
}
