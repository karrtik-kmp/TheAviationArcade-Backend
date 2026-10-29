import { RANKS, type Rank, rankIndex } from "./ranks.js";
import { type ModuleId } from "./modules.js";
import { FLIGHTS_PER_TRIP, MAX_FLIGHTS_AT_OWN_RANK } from "./catalog.js";

/**
 * The Trip dealer: a line-for-line port of the two Unity mock dealers, with the same seeded RNG, so the server
 * and the in-process mock deal the same Trip for the same (pool, rank, seed). Unity sources, all under
 * `Assets/_Project/Scripts/Infrastructure/DevMock/`:
 *   - `InProcessMockBackend.cs`          BuildDeck, PickQuestions, Fnv1a, DeckRandom   (policy `lower-ranks`)
 *   - `InProcessMockBackend.Military.cs` BuildMilitaryDeck, PickMilitaryQuestions     (policy `nearest-ranks`)
 *   - `MilitaryContent.cs`               NormalizeAnswer                              (`dealAnswerKey`)
 * Change both together; keep test names aligned with `MilitaryMockDeckTests` / `InProcessMockDeckParityTests`.
 *
 * Pure: no clock, no randomness beyond the seed, no I/O. Callers pass the pool in natural id order (the order of
 * the Unity bundle): the shuffles are positional, so the same set in another order deals another Trip.
 */

/** The two rules Unity deals with today. Not a product ruling (C13/J8): the ASSUMPTION tests pin current Unity. */
export type DealPolicy = "lower-ranks" | "nearest-ranks";

/** One dealable question. `photoKey` is the photo identity (Unity `PhotoId`); a blank key cannot be dealt. */
export type DealItem = {
  readonly id: string;
  readonly rank: Rank;
  readonly photoKey: string;
  readonly answer: string;
  readonly wrong: readonly [string, string, string];
};

/** One dealt Flight: the item and its four labelled options (slots A-D). */
export type DealtFlight = {
  readonly itemId: string;
  readonly choices: readonly [string, string, string, string];
  readonly correctIndex: 0 | 1 | 2 | 3;
};

/**
 * Which rule each Module is dealt by. v1 covers only the two Modules the Unity mock deals from a pool. A Module
 * with no entry is NOT dealt by the server: Airport Spotter has a third rule (`Airport.cs:117-137`), Tail has no
 * rank, and ATC, Call Sign and Code Search generate boards. ASSUMPTION: `dealTrip` and `tripCoverage` throw
 * `DealNotSupportedError` for them rather than guess a rule.
 */
export const DEAL_POLICY: Partial<Readonly<Record<ModuleId, DealPolicy>>> = {
  identifier: "lower-ranks",
  "aircraft-identifier-military": "nearest-ranks",
};

/** Thrown when a Module has no entry in `DEAL_POLICY`. */
export class DealNotSupportedError extends Error {
  readonly code = "deal_not_supported";
  constructor(readonly moduleId: string) {
    super(`Module "${moduleId}" is not dealt by the server (no DEAL_POLICY entry).`);
    this.name = "DealNotSupportedError";
  }
}

function policyFor(moduleId: ModuleId): DealPolicy {
  const policy = Object.hasOwn(DEAL_POLICY, moduleId) ? DEAL_POLICY[moduleId] : undefined;
  if (!policy) throw new DealNotSupportedError(moduleId);
  return policy;
}

// ---- answer key ----

/** True for what C# `char.IsLetterOrDigit(char)` is true for: categories L* (Lu Ll Lt Lm Lo) and Nd. */
const LETTER_OR_DIGIT = /^[\p{L}\p{Nd}]$/u;

/**
 * The key a nearest-ranks Trip dedupes answers on: a port of Unity `MilitaryContent.NormalizeAnswer`
 * (`answer.Where(char.IsLetterOrDigit).Select(char.ToLowerInvariant)`), deliberately NOT the Card key
 * `normalizeAnswerText` in `clipper-cards.ts` (which keeps punctuation and does NFC).
 *
 * It works on UTF-16 code units, as C# `char` does, never on code points:
 *  - A lone surrogate unit is category Cs, so it is dropped. A supplementary-plane letter or digit (for example
 *    U+1D7CE MATHEMATICAL BOLD DIGIT ZERO) is two surrogate units, so C# drops it whole.
 *  - Lower-casing is per unit and simple, like `char.ToLowerInvariant`: no context (final sigma stays plain sigma)
 *    and no length change. U+0130 is left unchanged (JS `toLowerCase` would give "i" + U+0307); this is the same
 *    on .NET, CoreCLR and Unity Mono.
 *  - No normalisation: NFC and NFD forms of the same text differ.
 *
 * Measured (independent review, over every BMP unit): Node matches CoreCLR (.NET 10) except for 21 Unicode 16/17
 * additions, and differs from Unity Mono/IL2CPP (6.13) for 333 units. All three agree on U+0000 to U+01C4, and
 * U+0130 is unchanged on all three. So the port is exact only on that range; outside it use `dealAnswerKeyIsPortable`
 * to guard content. A known Mono divergence: U+01C5 (Dz, titlecase) is lower-cased by Node but left unchanged by Mono.
 */
export function dealAnswerKey(answer: string): string {
  if (!answer) return "";
  let key = "";
  for (let i = 0; i < answer.length; i++) {
    const unit = answer[i] as string;
    if (!LETTER_OR_DIGIT.test(unit)) continue;
    key += unit.charCodeAt(0) === 0x0130 ? unit : unit.toLowerCase();
  }
  return key;
}

/**
 * True when every UTF-16 unit of `text` is in U+0000 to U+01C4, the range where Node, CoreCLR and Unity Mono/IL2CPP
 * agree on `dealAnswerKey`. B5 and the importer use it to guard content; today's client Military rows are ASCII.
 */
export function dealAnswerKeyIsPortable(text: string): boolean {
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 0x01c4) return false;
  return true;
}

// ---- RNG (Unity Fnv1a + DeckRandom) ----

/** FNV-1a 32 over the UTF-16 code units: a stable seed on every runtime. */
export function fnv1a(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

/** xorshift32; seed 0 becomes 0x9E3779B9. Shuffle is Fisher-Yates from the end with `Next(n) = u32 % n`. */
/** Exported for tests only (the seed-0 substitution). */
export class DeckRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed === 0 ? 0x9e3779b9 : seed >>> 0;
  }

  shuffle<T>(items: T[]): void {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.next(i + 1);
      const swap = items[i] as T;
      items[i] = items[j] as T;
      items[j] = swap;
    }
  }

  private next(maxExclusive: number): number {
    return this.nextUInt() % maxExclusive;
  }

  nextUInt(): number {
    let x = this.state;
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    this.state = x;
    return x;
  }
}

// ---- picking ----

const SLOTS = 4;

/** Unity PickQuestions: own rank up to 6, then lower ranks, then an own-rank top-up; distinct photos only. */
function pickLowerRanks(pool: readonly DealItem[], rank: Rank, random: DeckRandom): DealItem[] {
  const own = rankIndex(rank);
  const atRank: DealItem[] = [];
  const below: DealItem[] = [];
  for (const item of pool) {
    const level = rankIndex(item.rank);
    if (level === own) atRank.push(item);
    else if (level < own) below.push(item);
  }
  random.shuffle(atRank);
  random.shuffle(below);

  const picked: DealItem[] = [];
  const photos = new Set<string>();
  const take = (source: readonly DealItem[], upTo: number): void => {
    for (const item of source) {
      if (picked.length >= upTo || picked.length >= FLIGHTS_PER_TRIP) return;
      if (!photos.has(item.photoKey)) {
        photos.add(item.photoKey);
        picked.push(item);
      }
    }
  };
  take(atRank, MAX_FLIGHTS_AT_OWN_RANK);
  take(below, FLIGHTS_PER_TRIP);
  take(atRank, FLIGHTS_PER_TRIP); // a pool thin below this rank tops up from the rank itself

  random.shuffle(picked);
  return picked;
}

/**
 * Unity PickMilitaryQuestions: every own-rank item first (no cap of 6), then all other ranks nearest first
 * (higher ranks included; at equal distance the lower rank), distinct photos AND distinct `dealAnswerKey`s.
 */
function pickNearestRanks(pool: readonly DealItem[], rank: Rank, random: DeckRandom): DealItem[] {
  const own = rankIndex(rank);
  const atRank = pool.filter((item) => rankIndex(item.rank) === own);
  const others = pool.filter((item) => rankIndex(item.rank) !== own);
  random.shuffle(atRank);
  random.shuffle(others);
  // Array.prototype.sort is stable, like LINQ OrderBy: the shuffle holds within a (distance, rank) group.
  const fill = others.sort(
    (a, b) => Math.abs(rankIndex(a.rank) - own) - Math.abs(rankIndex(b.rank) - own) || rankIndex(a.rank) - rankIndex(b.rank),
  );

  const picked: DealItem[] = [];
  const photos = new Set<string>();
  const answers = new Set<string>();
  for (const item of [...atRank, ...fill]) {
    if (picked.length >= FLIGHTS_PER_TRIP) break;
    if (photos.has(item.photoKey)) continue;
    const key = dealAnswerKey(item.answer);
    if (answers.has(key)) continue;
    answers.add(key);
    photos.add(item.photoKey);
    picked.push(item);
  }

  random.shuffle(picked);
  return picked;
}

/**
 * The pool the server may deal: items whose `photoKey` is not blank or whitespace-only. Unity's importer drops
 * photo-less rows, but its dealers do NOT: `BuildDeck`/`BuildMilitaryDeck` deal a blank PhotoId (the first is
 * taken, later blanks dedupe on ""). So `dealTrip` deals what it is given, and callers (B4's pool builder, B5)
 * run the pool through this first. `tripCoverage` does.
 */
export function dealablePool(pool: readonly DealItem[]): DealItem[] {
  return pool.filter((item) => item.photoKey.trim() !== "");
}

/**
 * The Trip for a policy (the shared tail of Unity BuildDeck / BuildMilitaryDeck): pick, then
 * `answerSlots[i] = i % 4` shuffled, then per Flight the three wrong answers shuffled, the answer put in its slot.
 * RNG consumption order: the two pick shuffles, the final pick shuffle, the answer slots, then one distractor
 * shuffle per Flight. The pool is dealt as given (a blank photo key behaves as in Unity; see `dealablePool`).
 * Throws unless every item has exactly three wrong answers, as both Unity parsers do. Shorter than FLIGHTS_PER_TRIP only when the pool cannot fill it; an empty pool deals no Flights.
 */
export function dealTripWithPolicy(policy: DealPolicy, pool: readonly DealItem[], rank: Rank, seed: string): DealtFlight[] {
  const random = new DeckRandom(fnv1a(seed));
  for (const item of pool) {
    if (item.wrong.length !== 3) throw new Error(`Item "${item.id}" must have exactly 3 wrong answers.`);
  }
  const picked = policy === "nearest-ranks" ? pickNearestRanks(pool, rank, random) : pickLowerRanks(pool, rank, random);

  const answerSlots = picked.map((_, i) => i % SLOTS);
  random.shuffle(answerSlots);

  return picked.map((item, i) => {
    const distractors = [...item.wrong];
    random.shuffle(distractors);
    const answer = answerSlots[i] as 0 | 1 | 2 | 3;
    const choices: string[] = [];
    for (let slot = 0, next = 0; slot < SLOTS; slot++) choices.push(slot === answer ? item.answer : (distractors[next++] as string));
    return { itemId: item.id, choices: choices as unknown as DealtFlight["choices"], correctIndex: answer };
  });
}

/**
 * The Trip dealt to a pilot at `rank` for `seed` (the server uses the trip id), by the Module's rule.
 * Deterministic in (moduleId, pool order, rank, seed). Throws `DealNotSupportedError` for a Module with no
 * `DEAL_POLICY` entry.
 */
export function dealTrip(moduleId: ModuleId, pool: readonly DealItem[], rank: Rank, seed: string): DealtFlight[] {
  return dealTripWithPolicy(policyFor(moduleId), pool, rank, seed);
}

/** The seed `tripCoverage` deals with. Fixed so the count is repeatable. */
const COVERAGE_SEED = "trip-coverage";

/**
 * How many Flights a Trip at each rank would hold for this Module's pool, capped at FLIGHTS_PER_TRIP (below 10
 * means the pool cannot fill a Trip there). Counts only what `dealablePool` keeps (blank photos are excluded).
 * It deals with a fixed seed. Under lower-ranks the count is seed-independent: min(10, distinct photos at the own
 * and lower ranks). Under nearest-ranks it can vary by seed when one photo carries two answer keys (pool
 * [a p1 "X", b p1 "Y", c p2 "X"] at one rank deals 1 for seed "t0" and 2 for "t2"). Throws `DealNotSupportedError`
 * for an undealt Module.
 */
export function tripCoverage(moduleId: ModuleId, pool: readonly DealItem[]): Record<Rank, number> {
  const policy = policyFor(moduleId);
  const dealable = dealablePool(pool);
  const out = {} as Record<Rank, number>;
  for (const rank of RANKS) out[rank] = dealTripWithPolicy(policy, dealable, rank, COVERAGE_SEED).length;
  return out;
}
