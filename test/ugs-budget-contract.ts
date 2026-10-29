import { describe, expect, it } from "vitest";
import type { UgsBudget } from "../src/ugs/budget.js";

/**
 * The UgsBudget contract (D-4), run against every adapter: InMemoryUgsBudget in test/ugs.test.ts and
 * PostgresUgsBudget in test/ugs-pacing.e2e.test.ts. `make` returns a FULL budget (burst `capacity`, `perMin` per
 * minute) with no pause; for Postgres it also clears the row, so every test starts from a known state.
 */
export const T0 = Date.UTC(2026, 9, 29, 12, 0, 0);

export type MakeBudget = (perMin: number, capacity: number) => Promise<UgsBudget>;

export function budgetContract(name: string, make: MakeBudget): void {
  describe(`UgsBudget contract: ${name}`, () => {
    it("reserve grants 0..n and never more than the bucket holds", async () => {
      const budget = await make(60, 10);
      expect(await budget.reserve(3, T0)).toBe(3);
      expect(await budget.reserve(25, T0)).toBe(7); // only what is left of the burst
      expect(await budget.reserve(1, T0)).toBe(0);
      expect(await budget.reserve(0, T0)).toBe(0);
    });

    it("refills at perMin per minute up to the capacity, never beyond", async () => {
      const budget = await make(60, 10); // one token per second
      expect(await budget.reserve(10, T0)).toBe(10);
      expect(await budget.reserve(10, T0 + 6_000)).toBe(6);
      expect(await budget.reserve(10, T0 + 6_500)).toBe(0); // half a token is not a token
      expect(await budget.reserve(100, T0 + 600_000)).toBe(10); // capped at the capacity
    });

    it("refund gives unused tokens back, capped at the capacity", async () => {
      const budget = await make(60, 10);
      expect(await budget.reserve(10, T0)).toBe(10);
      await budget.refund(4, T0);
      expect(await budget.reserve(10, T0)).toBe(4);
      await budget.refund(100, T0);
      expect(await budget.reserve(100, T0)).toBe(10);
      await budget.refund(0, T0);
      await budget.refund(-3, T0);
      expect(await budget.reserve(1, T0)).toBe(0);
    });

    it("pause zeroes every grant until the deadline, then reservations resume", async () => {
      const budget = await make(60, 10);
      expect(await budget.reserve(1, T0)).toBe(1); // the row exists and is full
      await budget.pause(T0 + 30_000, T0);
      expect(await budget.isPaused(T0 + 1_000)).toBe(true);
      expect(await budget.reserve(5, T0 + 1_000)).toBe(0);
      expect(await budget.reserve(5, T0 + 29_999)).toBe(0);
      expect(await budget.isPaused(T0 + 30_000)).toBe(false);
      expect(await budget.reserve(5, T0 + 30_000)).toBe(5);
    });

    it("a pause never gets shorter, a longer one extends it", async () => {
      const budget = await make(60, 10);
      expect(await budget.reserve(1, T0)).toBe(1);
      await budget.pause(T0 + 60_000, T0);
      await budget.pause(T0 + 10_000, T0); // earlier deadline: ignored
      expect(await budget.reserve(1, T0 + 20_000)).toBe(0);
      await budget.pause(T0 + 90_000, T0);
      expect(await budget.reserve(1, T0 + 70_000)).toBe(0);
      expect(await budget.reserve(1, T0 + 90_000)).toBe(1);
    });

    it("a backwards clock is ignored: it mints no tokens", async () => {
      const budget = await make(60, 10);
      expect(await budget.reserve(10, T0 + 60_000)).toBe(10);
      expect(await budget.reserve(5, T0)).toBe(0); // an hour earlier by another instance's clock: nothing refilled
      expect(await budget.reserve(5, T0 + 60_000)).toBe(0);
      expect(await budget.reserve(5, T0 + 62_000)).toBe(2); // refill continues from the latest time seen
    });

    it("a refill time far in the future (a clock that jumped forward) does not freeze refills beyond the clamp", async () => {
      const budget = await make(60, 10);
      expect(await budget.reserve(10, T0 + 3 * 3_600_000)).toBe(10); // stamped three hours ahead by a wrong clock
      expect(await budget.reserve(5, T0)).toBe(0); // real time: empty, and the stored time is clamped back to now
      expect(await budget.reserve(5, T0 + 3_000)).toBe(3); // refilling again from real time, not frozen for three hours
      // Ordinary skew within the clamp keeps the stored time: an instance a minute behind mints nothing.
      expect(await budget.reserve(10, T0 + 600_000)).toBe(10);
      expect(await budget.reserve(5, T0 + 540_000)).toBe(0);
      expect(await budget.reserve(5, T0 + 600_000)).toBe(0);
      expect(await budget.reserve(5, T0 + 602_000)).toBe(2);
    });

    it("over a long run the total granted never exceeds capacity + rate x elapsed", async () => {
      const budget = await make(30, 10);
      let granted = 0;
      for (let t = 0; t <= 300_000; t += 1_000) {
        const got = await budget.reserve(7, T0 + t);
        granted += got;
        if (got > 2) await budget.refund(1, T0 + t); // some refunds along the way
        if (got > 2) granted -= 1;
      }
      expect(granted).toBeLessThanOrEqual(10 + 30 * 5);
      expect(granted).toBeGreaterThanOrEqual(30 * 5); // and it does use the rate
    });
  });
}
