import { describe, expect, it } from "vitest";
import { rowToDealItem } from "../src/content/deal-items.js";

const good = { answer: "F-16", wrong: ["F-15", "F-18", "F-22"], sourceFile: "MA_1.jpg", photographer: "P" };
const row = (data: unknown, rank = "captain") => ({ id: "mil-a1", rank, data });

describe("rowToDealItem", () => {
  it("maps a well-formed Military row (sourceFile is the photo identity)", () => {
    expect(rowToDealItem(row(good))).toEqual({ id: "mil-a1", rank: "captain", photoKey: "MA_1.jpg", answer: "F-16", wrong: ["F-15", "F-18", "F-22"] });
  });

  it("trims the file name and normalises it to NFC", () => {
    const decomposed = "Amélie.jpg"; // e + combining acute
    expect(rowToDealItem(row({ ...good, sourceFile: `  ${decomposed} ` }))?.photoKey).toBe("Amélie.jpg");
  });

  it("a blank or whitespace sourceFile still maps, with a blank photoKey (the dealer leaves it out)", () => {
    expect(rowToDealItem(row({ ...good, sourceFile: "" }))?.photoKey).toBe("");
    expect(rowToDealItem(row({ ...good, sourceFile: "   " }))?.photoKey).toBe("");
  });

  it.each([
    ["an unknown rank", row(good, "admiral")],
    ["a rank in display wording", row(good, "Captain")],
    ["null data", row(null)],
    ["data that is not an object", row("text")],
    ["a non-string answer", row({ ...good, answer: 5 })],
    ["a missing answer", row({ wrong: good.wrong, sourceFile: "a.jpg" })],
    ["a non-array wrong", row({ ...good, wrong: "F-15" })],
    ["wrong with 2 entries", row({ ...good, wrong: ["a", "b"] })],
    ["wrong with 4 entries", row({ ...good, wrong: ["a", "b", "c", "d"] })],
    ["a non-string wrong entry", row({ ...good, wrong: ["a", "b", 3] })],
    ["an empty-string wrong entry", row({ ...good, wrong: ["a", "", "c"] })],
    ["a non-string sourceFile", row({ ...good, sourceFile: 7 })],
    ["a missing sourceFile", row({ answer: "x", wrong: good.wrong })],
  ])("drops a row with %s", (_name, input) => {
    expect(rowToDealItem(input)).toBeUndefined();
  });
});
