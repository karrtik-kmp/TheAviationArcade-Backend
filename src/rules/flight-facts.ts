import { cardKeyFor } from "./clipper-cards.js";
import { SEED_COMMERCIAL_CARD_KEYS } from "./aircraft-tags.js";
import type { ModuleId } from "./modules.js";

/**
 * The Flight facts a Round result reports (ADR-0008 section 2: `aircraftKey`, `answerMs`, `attempts`) and the rules they
 * must satisfy (design 3.2, contract `RoundResultWithFlightFactsRequest`). Pure: the caller passes the Round's module and
 * the server's own issue-to-result time. A fact that fails is a 400 `invalid_request` and nothing is banked.
 *
 *  - `attempts` >= `errorCount`, and >= 1 when `finished` (A4: the only consistency rule; scoring keeps using errorCount).
 *  - `answerMs` may not exceed the server's issue-to-result time by more than 2,000 ms (A5).
 *  - `identifier`: `aircraftKey` is the Unity aircraft family and an exact key of the seeded commercial Card catalog
 *    (U9, `cardKeyFor`): a typo, a case variant (`a320`) or a Military key can never create a second Card.
 *  - `aircraft-identifier-military`: `aircraftKey` is the content item id (U3). The caller reads the item (approved or
 *    retired, A6) and its frozen Card key; this module only demands a value.
 *  - every other module: `aircraftKey` is null.
 */
export const ANSWER_MS_SLACK = 2000;

export type FlightFactsInput = {
  module: ModuleId;
  finished: boolean;
  errorCount: number;
  attempts: number;
  answerMs: number;
  aircraftKey: string | null;
};

export type FlightFactsCheck =
  | {
      ok: true;
      /** The commercial Card key (`identifier`), else null. */
      commercialKey: string | null;
      /** The Military content item id the caller must resolve to a stored item, else null. */
      militaryItemId: string | null;
    }
  | { ok: false; reason: string };

export function checkFlightFacts(
  facts: FlightFactsInput,
  elapsedMs: number,
  commercialCatalog: ReadonlySet<string> = SEED_COMMERCIAL_CARD_KEYS,
): FlightFactsCheck {
  if (facts.attempts < facts.errorCount) return { ok: false, reason: "attempts cannot be below errorCount." };
  if (facts.finished && facts.attempts < 1) return { ok: false, reason: "A finished Round has at least one attempt." };
  if (facts.answerMs > Math.max(0, elapsedMs) + ANSWER_MS_SLACK) {
    return { ok: false, reason: "answerMs is longer than the Round has been open." };
  }

  if (facts.module === "identifier") {
    if (facts.aircraftKey === null) return { ok: false, reason: "aircraftKey is required for identifier." };
    const card = cardKeyFor("identifier", facts.aircraftKey, commercialCatalog);
    if (card.kind !== "card") return { ok: false, reason: "aircraftKey is not a known aircraft family." };
    return { ok: true, commercialKey: card.key, militaryItemId: null };
  }
  if (facts.module === "aircraft-identifier-military") {
    if (facts.aircraftKey === null) {
      return { ok: false, reason: "aircraftKey (the question id) is required for aircraft-identifier-military." };
    }
    return { ok: true, commercialKey: null, militaryItemId: facts.aircraftKey };
  }
  if (facts.aircraftKey !== null) return { ok: false, reason: "aircraftKey must be null for this module." };
  return { ok: true, commercialKey: null, militaryItemId: null };
}
