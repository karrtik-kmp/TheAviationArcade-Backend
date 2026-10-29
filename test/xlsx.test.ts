import { strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  MAX_COLUMNS,
  MAX_ROWS,
  MAX_UNPACKED_BYTES,
  SpreadsheetError,
  assertSafeToUnpack,
  readFirstSheet,
  writeSheet,
} from "../src/content/xlsx.js";
import { xlsx } from "./fixtures.js";

async function failure(promise: Promise<unknown>): Promise<SpreadsheetError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SpreadsheetError);
    return error as SpreadsheetError;
  }
  throw new Error("expected a SpreadsheetError");
}

describe("xlsx reading and writing", () => {
  it("round-trips text, numbers and Unicode through write and read", async () => {
    const bytes = await writeSheet([
      ["Id", "Version", "Name"],
      ["mil-a1", 1, "Hartsfield–Jackson — Atlanta"],
      ["mil-a2", 12, "Café Über 日本"],
    ]);
    const rows = await readFirstSheet(bytes);
    expect(rows[0]).toEqual(["Id", "Version", "Name"]);
    expect(rows[1]).toEqual(["mil-a1", 1, "Hartsfield–Jackson — Atlanta"]);
    expect(rows[2]).toEqual(["mil-a2", 12, "Café Über 日本"]);
  });

  it("reads blank cells as null", async () => {
    const rows = await readFirstSheet(await xlsx([["a", null, "c"]]));
    expect(rows[0]).toEqual(["a", null, "c"]);
  });

  it("rejects bytes that are not a zip", async () => {
    const error = await failure(readFirstSheet(new TextEncoder().encode("not a spreadsheet at all")));
    expect(error.message).toContain("not an .xlsx");
  });

  it("rejects a zip that is not a spreadsheet", async () => {
    const zip = zipSync({ "readme.txt": new TextEncoder().encode("hello") });
    await failure(readFirstSheet(zip));
  });

  it("rejects a zip bomb by counting inflated bytes, quickly and without parsing", async () => {
    // 60 MB of zeros deflates to roughly 60 KB. The guard must stop at 25 MB of real output.
    const bomb = zipSync({ "xl/worksheets/sheet1.xml": new Uint8Array(60 * 1024 * 1024) }, { level: 9 });
    expect(bomb.length).toBeLessThan(1024 * 1024);
    const started = Date.now();
    const error = await failure(readFirstSheet(bomb));
    expect(error.message).toBe("Spreadsheet is too large when unpacked.");
    expect(error.tooLarge).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("counts several entries together against the same total", () => {
    const chunk = new Uint8Array(Math.ceil(MAX_UNPACKED_BYTES / 3) + 1024);
    const zip = zipSync({ "a.xml": chunk, "b.xml": chunk, "c.xml": chunk }, { level: 9 });
    expect(() => assertSafeToUnpack(zip)).toThrow("too large when unpacked");
  });

  it("rejects a zip with too many entries", () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < 101; i++) files[`f${i}.xml`] = new Uint8Array(1);
    expect(() => assertSafeToUnpack(zipSync(files))).toThrow("too large when unpacked");
  });

  it("rejects a sheet with too many rows or columns", async () => {
    const tall = await xlsx(Array.from({ length: MAX_ROWS + 1 }, (_, i) => [`r${i}`]));
    expect((await failure(readFirstSheet(tall))).message).toContain("rows");
    const wide = await xlsx([Array.from({ length: MAX_COLUMNS + 1 }, (_, i) => `c${i}`)]);
    expect((await failure(readFirstSheet(wide))).message).toContain("columns");
  });

  describe("sparse sheets (read-excel-file would allocate up to the highest cell)", () => {
    /** A real one-cell xlsx with its cell and dimension rewritten to `ref`, as a hostile file would be. */
    async function sparse(ref: string, dimension = `A1:${ref}`): Promise<Uint8Array> {
      const files = unzipSync(await xlsx([["x"]]));
      const name = Object.keys(files).find((n) => /^xl\/worksheets\/sheet1\.xml$/.test(n));
      if (!name) throw new Error("no sheet1");
      const xml = new TextDecoder()
        .decode(files[name])
        .replace(/<c r="A1"/, `<c r="${ref}"`)
        .replace(/<dimension ref="[^"]*"\s*\/>/, "")
        .replace("<sheetData>", `<dimension ref="${dimension}"/><sheetData>`)
        .replace(/<row r="1"/, `<row r="${ref.replace(/^[A-Z]+/, "")}"`);
      files[name] = strToU8(xml);
      return zipSync(files);
    }

    for (const ref of ["XFD1048576", "ZZ100000", "A5001", "AY1", "B1048576"]) {
      it(`${ref} is refused up front, quickly, without allocating the sheet`, async () => {
        const bytes = await sparse(ref);
        expect(bytes.length).toBeLessThan(10_000);
        const before = process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers;
        const started = Date.now();
        const error = await failure(readFirstSheet(bytes));
        expect(error.tooLarge).toBe(true);
        expect(error.message).toMatch(/rows|columns/);
        expect(Date.now() - started).toBeLessThan(3000);
        expect(process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers - before).toBeLessThan(100 * 1024 * 1024);
      });
    }

    it("a dimension alone (no cell that far out) is refused too", async () => {
      const bytes = await sparse("A1", "A1:XFD1048576");
      expect((await failure(readFirstSheet(bytes))).tooLarge).toBe(true);
    });

    it("the limits themselves are fine: column AX (50) and row 5000", async () => {
      expect(await readFirstSheet(await sparse("AX5000"))).toHaveLength(5000);
    });

    it("sees a tag split across inflate chunks", () => {
      const filler = " ".repeat(200_000);
      const xml = `<worksheet><sheetData><row r="1"><c r="A1"/>${filler}<c r="ZZ100000"/></row></sheetData></worksheet>`;
      expect(() => assertSafeToUnpack(zipSync({ "xl/worksheets/sheet1.xml": strToU8(xml) }))).toThrow(/rows|columns/);
    });
  });
});
