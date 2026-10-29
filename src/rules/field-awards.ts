import { FIELD_AWARD_CATALOG } from "./field-award-catalog.js";
import { hasTag, isFighterJet } from "./aircraft-tags.js";
import type { AircraftTag, AircraftTagTable } from "./aircraft-tags.js";
import type { CardRecord } from "./clipper-cards.js";
import type { PlayerCounters } from "./trips.js";

/**
 * The 28 Field Awards: ids, metrics and the pure evaluator. Mirrors Unity Achievements.cs
 * (`AchievementMetric`, `PilotRecord.Value`, `AchievementBoard.Evaluate`) with the contract-round rulings applied:
 * Military Cards count (design 11 item 5), tag awards read the tag document (U8), no award pays Miles or SP.
 * The catalog text and thresholds are data (field-award-catalog.ts), the metrics are code (design 3.6).
 */
export const FIELD_AWARD_IDS = [
  "first-flight",
  "frequent-flyer",
  "century",
  "sharp-eyes",
  "flawless-five",
  "five-in-a-row",
  "week-on-the-line",
  "regular",
  "first-card",
  "collector",
  "textbook",
  "high-flyer",
  "coast-to-coast",
  "no-instrument-flight",
  "red-eye-special",
  "fleet-admiral",
  "centennial-streak",
  "go-around",
  "globe-trotter",
  "quad-engine-royalty",
  "the-great-rivalry",
  "heavy-metal",
  "regional",
  "bogey-identified",
  "top-gun-ace",
  "rotorhead",
  "vertical-horizon",
  "executive-platinum",
] as const;
export type FieldAwardId = (typeof FIELD_AWARD_IDS)[number];

export const FIELD_AWARD_METRICS = [
  "trips-completed",
  "flights-completed",
  "identifier-full-trips",
  "best-perfect-flight-streak",
  "best-day-streak",
  "cards-collected",
  "perfect-cards",
  "miles-earned",
  "best-hint-free-trip-streak",
  "night-trips",
  "go-arounds",
  "quad-engine-cards",
  "rivalry-balance",
  "heavy-cards",
  "regional-cards",
  "quick-fighter-id",
  "fighter-aces",
  "rotary-identified",
  "vtol-identified",
] as const;
export type FieldAwardMetric = (typeof FIELD_AWARD_METRICS)[number];

/** A Bogey Identified Quick ID is strictly under this many milliseconds (AwardCounters.QuickIdSeconds). */
export const QUICK_ID_MS = 2000;

export type FieldAwardRuling = {
  field: string;
  text: string;
  source: string;
  status: "confirmed" | "resolved" | "to-confirm";
};

export type FieldAwardDefinition = {
  id: FieldAwardId;
  /** The id in the sheet snapshot, for traceability. */
  sheetId: string;
  sheetRow: number;
  /** The sheet's Name, verbatim. */
  title: string;
  /** The sheet's Criteria, verbatim (typos included, U10). */
  criteria: string;
  /** The sheet's threshold cell, verbatim. */
  thresholdCell: string;
  target: number;
  metric: FieldAwardMetric;
  hidden: boolean;
  /** Counts aircraft tags authored by us (U8): the number can move when the client's attribute grid arrives. */
  provisional: boolean;
  rulings: readonly FieldAwardRuling[];
};

export { FIELD_AWARD_CATALOG };

/** What the metrics read. Counters + Cards (from `player_clipper_cards`) + the tag document in force. */
export type AwardInputs = {
  counters: PlayerCounters;
  cards: readonly CardRecord[];
  tags: AircraftTagTable;
};

/**
 * The metric's current value (uncapped). Scopes (design 3.6, A12): Card-count metrics and the quad, heavy,
 * regional and rivalry tags count every Card, commercial and Military; the four Military awards (Bogey, Top Gun,
 * Rotorhead, Vertical Horizon) count Military Cards only. A Card with no tag entry carries no tags.
 */
export function metricValue(metric: FieldAwardMetric, inputs: AwardInputs): number {
  const { counters, cards, tags } = inputs;
  const military = cards.filter((c) => c.module === "aircraft-identifier-military");
  const count = (list: readonly CardRecord[], tag: AircraftTag) =>
    list.filter((c) => hasTag(tags, c.key, tag)).length;
  switch (metric) {
    case "trips-completed":
      return counters.tripsCompleted;
    case "flights-completed":
      return counters.flightsCompleted;
    case "identifier-full-trips":
      return counters.identifierFullTrips;
    case "best-perfect-flight-streak":
      return counters.bestPerfectFlightStreak;
    case "best-day-streak":
      return counters.bestDayStreak;
    case "cards-collected":
      return cards.length;
    case "perfect-cards":
      return cards.filter((c) => c.everPerfect).length;
    case "miles-earned":
      return counters.milesEarned;
    case "best-hint-free-trip-streak":
      return counters.bestHintFreeTripStreak;
    case "night-trips":
      return counters.nightTrips;
    case "go-arounds":
      return counters.goArounds;
    case "quad-engine-cards":
      return count(cards, "quad-engine");
    case "heavy-cards":
      return count(cards, "heavy");
    case "regional-cards":
      return count(cards, "regional-jet");
    case "rivalry-balance": {
      let boeing = 0;
      let airbus = 0;
      for (const c of cards) {
        const maker = tags.get(c.key)?.manufacturer;
        if (maker === "Boeing") boeing += 1;
        else if (maker === "Airbus") airbus += 1;
      }
      return Math.min(boeing, airbus);
    }
    case "quick-fighter-id":
      return military.some(
        (c) => isFighterJet(tags, c.key) && c.fastestCorrectMs !== null && c.fastestCorrectMs < QUICK_ID_MS,
      )
        ? 1
        : 0;
    case "fighter-aces":
      return military.filter((c) => hasTag(tags, c.key, "fighter-attack") && c.everHintFree).length;
    case "rotary-identified":
      return count(military, "military-rotary");
    case "vtol-identified":
      return count(military, "vtol");
  }
}

export type FieldAwardProgress = {
  id: FieldAwardId;
  /** The metric's value, capped at the target (Unity AchievementProgress.Current). */
  current: number;
  target: number;
  earned: boolean;
  /** Earned by this evaluation (not in `alreadyEarned`); the caller inserts these rows. */
  newlyEarned: boolean;
};

export type FieldAwardEvaluation = {
  /** Every award, in catalog order: locked ones included, with their progress. */
  awards: readonly FieldAwardProgress[];
  /** Ids earned by this evaluation, in catalog order. */
  newlyEarned: readonly FieldAwardId[];
  earnedCount: number;
};

/**
 * A usable target: an integer >= 1. A fraction rounds up (3.2 -> 4: the metric is a whole number), 0 or a negative
 * becomes 1 (an award that is earned at zero would be earned by everybody), and NaN or an infinite value is a catalog
 * bug and throws.
 */
export function effectiveTarget(target: number): number {
  if (!Number.isFinite(target)) throw new RangeError(`award target is not a finite number: ${target}`);
  return Math.max(1, Math.ceil(target));
}

/**
 * Judges every award in the catalog. `alreadyEarned` are the ids with a stored row: an award never un-earns, even if
 * its target is later raised or a Card's tags change (U7). A lowered target is awarded here, at the next evaluation.
 * An award whose content does not exist yet (Fleet Admiral with 14 Cards) is simply locked with its progress; it
 * advances the moment the content appears, because nothing here knows what content exists.
 */
export function evaluateFieldAwards(
  catalog: readonly FieldAwardDefinition[],
  inputs: AwardInputs,
  alreadyEarned: ReadonlySet<FieldAwardId> = new Set(),
): FieldAwardEvaluation {
  const awards: FieldAwardProgress[] = [];
  const newlyEarned: FieldAwardId[] = [];
  for (const def of catalog) {
    const value = Math.max(0, metricValue(def.metric, inputs));
    const target = effectiveTarget(def.target);
    const reached = value >= target;
    const stored = alreadyEarned.has(def.id);
    const earned = stored || reached;
    const isNew = earned && !stored;
    awards.push({
      id: def.id,
      // As is when earned: after a raised target a stored award can read current < target (design 6, Logbook).
      current: Math.min(value, target),
      target,
      earned,
      newlyEarned: isNew,
    });
    if (isNew) newlyEarned.push(def.id);
  }
  return { awards, newlyEarned, earnedCount: awards.filter((a) => a.earned).length };
}

/** Passport figure "3 / 28" (Unity AchievementBoard.CountLabel). */
export function awardCountLabel(evaluation: FieldAwardEvaluation): string {
  return `${evaluation.earnedCount} / ${evaluation.awards.length}`;
}

/**
 * NEARLY THERE: the unearned, visible award with the most progress; first in catalog order on a tie; null when
 * nothing is under way (Unity AchievementBoard.NearlyThere).
 */
export function nearlyThere(
  catalog: readonly FieldAwardDefinition[],
  evaluation: FieldAwardEvaluation,
): FieldAwardProgress | null {
  let best: FieldAwardProgress | null = null;
  const hidden = new Set(catalog.filter((d) => d.hidden).map((d) => d.id));
  for (const p of evaluation.awards) {
    if (p.earned || hidden.has(p.id) || p.current <= 0) continue;
    if (p.target <= 0) continue; // evaluateFieldAwards never emits one; a hand-built evaluation must not divide by 0
    if (best === null || p.current / p.target > best.current / best.target) best = p;
  }
  return best;
}
