import { describe, expect, it } from "vitest";
import { FURTHEST_AHEAD_ZONE, calendarDay, clampToFurthest, parseTimeZone, viewerDay } from "../src/content/editorial/local-day.js";

describe("parseTimeZone", () => {
  it.each(["+2359", "+23:59", "+14", "-05", "-0530", "+00:00", "Etc/../x", "../x", "Europe/../London", "a".repeat(65), "", " UTC", "UTC ", "Europe/London\n", "5/6", "_UTC", "GMT+5", "UTC+3", "Nowhere/City", "Z"])(
    "refuses %j",
    (raw) => {
      expect(parseTimeZone(raw)).toBeUndefined();
    },
  );

  it("refuses an offset zone even though Node accepts it", () => {
    // The point of the explicit refusal: this really is accepted by Intl, and +23:59 would show tomorrow's UTC feature from 00:01.
    expect(() => new Intl.DateTimeFormat("en-US", { timeZone: "+23:59" })).not.toThrow();
    expect(parseTimeZone("+23:59")).toBeUndefined();
  });

  it("accepts real zones", () => {
    expect(parseTimeZone("Pacific/Kiritimati")).toBe("Pacific/Kiritimati");
    expect(parseTimeZone("America/New_York")).toBe("America/New_York");
    expect(parseTimeZone("UTC")).toBe("UTC");
    expect(parseTimeZone("Etc/GMT-14")).toBe("Etc/GMT-14");
    expect(parseTimeZone("utc")).toBe("UTC");
    expect(parseTimeZone("a".repeat(64))).toBeUndefined(); // 64 characters but not a zone
  });
});

describe("calendarDay (formatToParts)", () => {
  it("is the zone's date at the instant, at the day boundaries", () => {
    const at = new Date("2026-11-05T23:59:59.999Z");
    expect(calendarDay("UTC", at)).toBe("2026-11-05");
    expect(calendarDay("UTC", new Date("2026-11-06T00:00:00.000Z"))).toBe("2026-11-06");
    expect(calendarDay("Pacific/Kiritimati", new Date("2026-11-05T09:59:59.999Z"))).toBe("2026-11-05");
    expect(calendarDay("Pacific/Kiritimati", new Date("2026-11-05T10:00:00.000Z"))).toBe("2026-11-06");
    expect(calendarDay("America/New_York", new Date("2026-11-05T04:59:59.999Z"))).toBe("2026-11-04"); // EST from 1 Nov: UTC-5
    expect(calendarDay("America/New_York", new Date("2026-11-05T05:00:00.000Z"))).toBe("2026-11-05");
    expect(calendarDay("Pacific/Pago_Pago", new Date("2026-11-05T10:59:59.999Z"))).toBe("2026-11-04"); // UTC-11
    expect(calendarDay("Pacific/Pago_Pago", new Date("2026-11-05T11:00:00.000Z"))).toBe("2026-11-05");
  });

  it("follows daylight saving time", () => {
    expect(calendarDay("America/New_York", new Date("2026-07-05T03:59:59.999Z"))).toBe("2026-07-04"); // EDT: UTC-4
    expect(calendarDay("America/New_York", new Date("2026-07-05T04:00:00.000Z"))).toBe("2026-07-05");
  });

  it("pads the year, month and day", () => {
    expect(calendarDay("UTC", new Date("2026-01-02T03:04:05Z"))).toBe("2026-01-02");
  });
});

describe("viewerDay", () => {
  it("ASSUMPTION: a UTC+14 viewer sees the next UTC date's feature, never the one after", () => {
    const at = new Date("2026-11-05T10:00:00.000Z");
    expect(viewerDay("Pacific/Kiritimati", at)).toBe("2026-11-06");
    expect(viewerDay("Pacific/Kiritimati", new Date("2026-11-05T09:59:59.999Z"))).toBe("2026-11-05");
    for (const hour of [0, 6, 9, 10, 15, 23]) {
      const instant = new Date(Date.UTC(2026, 10, 5, hour, 30));
      const next = new Date(Date.UTC(2026, 10, 6)).toISOString().slice(0, 10);
      expect(viewerDay("Pacific/Kiritimati", instant) <= next, `hour ${hour}`).toBe(true);
    }
    expect(calendarDay(FURTHEST_AHEAD_ZONE, at)).toBe("2026-11-06");
  });

  it("the clamp is independent: a day later than the furthest zone's date is cut back to it", () => {
    const at = new Date("2026-11-05T11:00:00.000Z"); // 2026-11-06 in UTC+14
    expect(clampToFurthest("2026-11-07", at)).toBe("2026-11-06");
    expect(clampToFurthest("2027-01-01", at)).toBe("2026-11-06");
    expect(clampToFurthest("2026-11-06", at)).toBe("2026-11-06");
    expect(clampToFurthest("2026-11-05", at)).toBe("2026-11-05");
    expect(viewerDay(FURTHEST_AHEAD_ZONE, at)).toBe("2026-11-06");
    expect(viewerDay("UTC", at)).toBe("2026-11-05");
    expect(viewerDay("America/Los_Angeles", at)).toBe("2026-11-05");
  });

  it("an earlier zone is never moved forward", () => {
    expect(viewerDay("Pacific/Pago_Pago", new Date("2026-11-05T00:30:00Z"))).toBe("2026-11-04");
  });
});
