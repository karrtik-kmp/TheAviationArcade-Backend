import writeXlsxFile from "write-excel-file/node";

export type TestCell = string | number | null;

/** A one-sheet xlsx from plain rows. null and "" are blank cells. */
export async function xlsx(rows: TestCell[][]): Promise<Buffer> {
  const sheet = rows.map((row) => row.map((value) => (value === null || value === "" ? null : { value })));
  return writeXlsxFile(sheet).toBuffer();
}

export const CLIENT_HEADER = ["Level", "Correct Answer", "Wrong Answer 1", "Wrong Answer 2", "Wrong Answer 3", "file", "Photographer"];

const LEVEL_CYCLE = ["Trainee", "First Officer", "Captain", "Check Airman", "Chief Pilot"];

/** A client-shaped data row n (1-based): distinct answers, a .jpg file name, a photographer. */
export function clientRow(n: number): TestCell[] {
  return [
    LEVEL_CYCLE[(n - 1) % LEVEL_CYCLE.length] ?? "Trainee",
    `Aircraft ${n}`,
    `Wrong ${n}a`,
    `Wrong ${n}b`,
    `Wrong ${n}c`,
    `MA_test_${n}.jpg`,
    `Photographer ${n}`,
  ];
}

/**
 * The client's layout: two blank rows, the header on sheet row 3, `count` data rows, then two placeholder
 * rows that carry only a Level (as in "Military Airplane Identifier v1.xlsx").
 */
export async function clientSheet(count = 31, edit?: (rows: TestCell[][]) => void): Promise<Buffer> {
  const rows: TestCell[][] = [
    [null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null],
    CLIENT_HEADER,
    ...Array.from({ length: count }, (_, i) => clientRow(i + 1)),
    ["Trainee", null, null, null, null, null, null],
    ["Captain", null, null, null, null, null, null],
  ];
  edit?.(rows);
  return xlsx(rows);
}
