import { describe, expect, it } from "vitest";
import {
  activeRankFor,
  certifiedRankFor,
  nextRankFor,
  RANK_THRESHOLDS,
} from "../src/rules/ranks.js";
import { HINTS_PER_ROUND, MILES_HINT_PACK, STARTER_HINTS } from "../src/rules/hints.js";
import { nextPerfectStreak, scoreRound } from "../src/rules/scoring.js";
import type { RoundInput } from "../src/rules/scoring.js";

// Test names mirror the Unity ScoreCalculatorTests so a spec ruling breaks the same-named test in both.
function round(overrides: Partial<RoundInput> = {}): RoundInput {
  return {
    finished: true,
    errorCount: 0,
    usedHint: false,
    timeRemainingFraction: 0.2,
    perfectStreak: 0,
    firstClassPass: false,
    pleasureCruise: false,
    ...overrides,
  };
}

describe("scoreRound", () => {
  it("perfect completion with no speed bonus awards 50/50", () => {
    expect(scoreRound(round())).toMatchObject({ completion: "perfect", statusPoints: 50, miles: 50 });
  });

  it("errors downgrade the award to standard completion", () => {
    expect(scoreRound(round({ errorCount: 3 }))).toMatchObject({
      completion: "standard",
      statusPoints: 30,
      miles: 30,
    });
  });

  it("using a hint forfeits perfect completion even with zero errors", () => {
    expect(scoreRound(round({ usedHint: true })).completion).toBe("standard");
  });

  it("ASSUMPTION: speed bonus is additive with the completion award", () => {
    expect(scoreRound(round({ timeRemainingFraction: 0.6 }))).toMatchObject({
      speedBonus: true,
      statusPoints: 70,
      miles: 70,
    });
  });

  it("speed bonus needs strictly more than half the clock", () => {
    expect(scoreRound(round({ timeRemainingFraction: 0.5 })).speedBonus).toBe(false);
  });

  it("streak awards miles only, never status points", () => {
    expect(scoreRound(round({ perfectStreak: 2 }))).toMatchObject({
      streakMiles: 10,
      statusPoints: 50,
      miles: 60,
    });
  });

  it("streak miles cap at 25", () => {
    expect(scoreRound(round({ perfectStreak: 40 })).streakMiles).toBe(25);
  });

  it("first class pass applies a 50 percent multiplier", () => {
    expect(scoreRound(round({ firstClassPass: true }))).toMatchObject({ statusPoints: 75, miles: 75 });
  });

  it("pleasure cruise caps the base payout at 10", () => {
    expect(scoreRound(round({ pleasureCruise: true, timeRemainingFraction: 0.9 }))).toMatchObject({
      statusPoints: 10,
      miles: 10,
    });
  });

  it("ASSUMPTION: pleasure cruise cap is applied before the first class multiplier", () => {
    expect(scoreRound(round({ pleasureCruise: true, firstClassPass: true }))).toMatchObject({
      statusPoints: 15,
      miles: 15,
    });
  });

  it("ten perfect games with speed bonus match the spec's worked example", () => {
    let statusPoints = 0;
    for (let i = 0; i < 10; i++) {
      statusPoints += scoreRound(round({ timeRemainingFraction: 0.9 })).statusPoints;
    }
    expect(statusPoints).toBe(700);
  });

  it("ASSUMPTION: an unfinished round pays nothing and breaks the perfect streak", () => {
    const award = scoreRound(round({ finished: false, perfectStreak: 4, timeRemainingFraction: 0.9 }));
    expect(award).toMatchObject({ completion: "unfinished", statusPoints: 0, miles: 0, streakMiles: 0 });
    expect(nextPerfectStreak(4, award.completion)).toBe(0);
  });

  it("only a perfect completion extends the streak", () => {
    expect(nextPerfectStreak(2, "perfect")).toBe(3);
    expect(nextPerfectStreak(2, "standard")).toBe(0);
  });
});

describe("scoreRound edge cases", () => {
  it("standard round with streak 1 and First Class rounds miles half-up to 53 and pays 45 SP", () => {
    // 30 SP; Miles 30 + 5 streak = 35; x1.5 = 52.5 -> 53, SP 45.
    expect(scoreRound(round({ errorCount: 1, perfectStreak: 1, firstClassPass: true }))).toMatchObject({
      completion: "standard",
      statusPoints: 45,
      miles: 53,
    });
  });

  it("Pleasure Cruise caps both SP and Miles at 10 even with a streak of 3", () => {
    expect(scoreRound(round({ perfectStreak: 3, pleasureCruise: true }))).toMatchObject({
      streakMiles: 15,
      statusPoints: 10,
      miles: 10,
    });
  });
});

describe("ranks", () => {
  it("certified rank follows the status point thresholds", () => {
    expect(certifiedRankFor(0)).toBe("trainee");
    expect(certifiedRankFor(9_999)).toBe("trainee");
    expect(certifiedRankFor(10_000)).toBe("first-officer");
    expect(certifiedRankFor(50_000)).toBe("captain");
    expect(certifiedRankFor(100_000)).toBe("check-airman");
  });

  it("chief pilot is certified at 400,000 SP", () => {
    expect(RANK_THRESHOLDS["chief-pilot"]).toBe(400_000);
    expect(certifiedRankFor(399_999)).toBe("check-airman");
    expect(certifiedRankFor(400_000)).toBe("chief-pilot");
  });

  it("next rank reports the following threshold, and none at the top", () => {
    expect(nextRankFor(12_000)).toEqual({ rank: "captain", statusPoints: 50_000 });
    expect(nextRankFor(250_000)).toEqual({ rank: "chief-pilot", statusPoints: 400_000 });
    expect(nextRankFor(450_000)).toBeNull();
  });

  it("active rank defaults to certified when none is stored", () => {
    expect(activeRankFor(60_000, null)).toBe("captain");
  });

  it("a stored active rank above certified is clamped to certified", () => {
    expect(activeRankFor(0, "chief-pilot")).toBe("trainee");
    expect(activeRankFor(60_000, "not-a-rank")).toBe("captain");
  });
});

describe("hints", () => {
  it("a new player starts with five hints (Unity HintBank.StarterHints)", () => {
    expect(STARTER_HINTS).toBe(5);
  });

  it("a Round allows one hint (Unity TripProfiles.Hints)", () => {
    expect(HINTS_PER_ROUND).toBe(1);
  });

  it("the Miles hint pack is 10 hints for 5,000 Miles (client ruling CF-53, Unity MilesHintPack)", () => {
    expect(MILES_HINT_PACK).toEqual({ hints: 10, priceMiles: 5000 });
  });
});
