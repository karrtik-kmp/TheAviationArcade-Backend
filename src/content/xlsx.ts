import { Unzip, UnzipInflate, UnzipPassThrough } from "fflate";
import { readSheet } from "read-excel-file/node";
import writeXlsxFile from "write-excel-file/node";

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Raw upload cap (also the body parser limit for the import route). */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
/** Zip-bomb bounds, counted on actual inflated output, not on sizes the archive declares. */
export const MAX_UNPACKED_BYTES = 25 * 1024 * 1024;
export const MAX_ZIP_ENTRIES = 100;
/** Parsed-sheet bounds. */
export const MAX_ROWS = 5000;
export const MAX_COLUMNS = 50;

/** A cell as read from the sheet. Blank cells are null. */
export type Cell = string | number | boolean | Date | null;
export type SheetRow = Cell[];

/** The upload is not a usable spreadsheet. The message is safe to show to the (staff) caller. */
export class SpreadsheetError extends Error {
  constructor(
    message: string,
    /** True when the file is too large once unpacked (or too many rows/columns): 413-ish, reported as 400. */
    readonly tooLarge = false,
  ) {
    super(message);
    this.name = "SpreadsheetError";
  }
}

/** A thrown marker so a limit breach unwinds out of fflate's synchronous callbacks. */
class LimitExceeded extends Error {}
/** A worksheet addresses a cell beyond MAX_ROWS or MAX_COLUMNS. */
class SheetTooBig extends Error {}

const WORKSHEET_ENTRY = /^xl\/worksheets\/[^/]+\.xml$/i;
/** Enough carried-over text that a tag split across two inflated chunks is still seen whole. */
const SCAN_TAIL = 1024;
const DIMENSION_TAG = /<(?:\w+:)?dimension(?=\s)[^>]{0,300}?\sref\s*=\s*["']([^"']*)["']/g;
const ROW_TAG = /<(?:\w+:)?row(?=\s)[^>]{0,300}?\sr\s*=\s*["'](\d+)["']/g;
const CELL_TAG = /<(?:\w+:)?c(?=\s)[^>]{0,300}?\sr\s*=\s*["']([A-Za-z]+)(\d+)["']/g;

/** 1-based column number of letters like "AB", or Infinity when it is absurdly long. */
function columnNumber(letters: string): number {
  if (letters.length > 3) return Number.POSITIVE_INFINITY;
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function checkAddress(letters: string, digits: string): void {
  if (columnNumber(letters) > MAX_COLUMNS || digits.length > 7 || Number(digits) > MAX_ROWS) throw new SheetTooBig();
}

/**
 * read-excel-file fills a sparse sheet out to its highest cell: one cell at XFD1048576 in a 2.7 KB file
 * allocates gigabytes and kills the process. So the worksheet XML is scanned as it inflates, BEFORE any
 * parsing, for the dimension, row numbers and cell references, and a sheet that reaches past MAX_ROWS rows
 * or MAX_COLUMNS columns is refused. Every worksheet is checked, not only the first (cheap, and no workbook
 * parsing is needed to know which is first). Memory stays bounded by one chunk plus SCAN_TAIL.
 */
class WorksheetScanner {
  private tail = "";

  push(chunk: Uint8Array): void {
    const text = this.tail + Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString("latin1");
    for (const match of text.matchAll(DIMENSION_TAG)) {
      for (const part of (match[1] ?? "").split(":")) {
        const ref = /^([A-Za-z]+)(\d+)$/.exec(part.trim());
        if (ref) checkAddress(ref[1] ?? "", ref[2] ?? "");
      }
    }
    for (const match of text.matchAll(ROW_TAG)) {
      const row = match[1] ?? "";
      if (row.length > 7 || Number(row) > MAX_ROWS) throw new SheetTooBig();
    }
    for (const match of text.matchAll(CELL_TAG)) checkAddress(match[1] ?? "", match[2] ?? "");
    this.tail = text.slice(-SCAN_TAIL);
  }
}

/**
 * Inflate every zip entry with fflate's streaming Unzip, counting the bytes actually produced, and give up
 * past MAX_UNPACKED_BYTES or MAX_ZIP_ENTRIES. read-excel-file has no such guard: a 412 KB xlsx that inflates
 * to 400 MB used ~1 GB of memory and crashed it, so this runs BEFORE any parsing. It also refuses sheets that
 * address cells beyond MAX_ROWS / MAX_COLUMNS (see WorksheetScanner). Output is discarded as it
 * is produced, so memory stays bounded by one chunk.
 */
export function assertSafeToUnpack(bytes: Uint8Array): void {
  // A zip starts with a local file header: "PK\x03\x04".
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
    throw new SpreadsheetError("The file is not an .xlsx spreadsheet.");
  }
  let total = 0;
  let entries = 0;
  const unzip = new Unzip((file) => {
    entries += 1;
    if (entries > MAX_ZIP_ENTRIES) throw new LimitExceeded();
    const scanner = WORKSHEET_ENTRY.test(file.name) ? new WorksheetScanner() : undefined;
    file.ondata = (error, chunk) => {
      if (error) throw error;
      scanner?.push(chunk);
      total += chunk.length;
      if (total > MAX_UNPACKED_BYTES) {
        file.terminate();
        throw new LimitExceeded();
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);
  try {
    unzip.push(bytes, true);
  } catch (error) {
    if (error instanceof LimitExceeded) throw new SpreadsheetError("Spreadsheet is too large when unpacked.", true);
    if (error instanceof SheetTooBig) {
      throw new SpreadsheetError(`The spreadsheet has more than ${MAX_ROWS} rows or ${MAX_COLUMNS} columns.`, true);
    }
    throw new SpreadsheetError("The file is not a readable .xlsx spreadsheet.");
  }
  if (entries === 0) throw new SpreadsheetError("The file is not an .xlsx spreadsheet.");
}

/** Rows of the first worksheet. Guards the unpacked size first, then caps rows and columns. */
export async function readFirstSheet(bytes: Uint8Array): Promise<SheetRow[]> {
  assertSafeToUnpack(bytes);
  let rows: unknown[][];
  try {
    rows = (await readSheet(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))) as unknown[][];
  } catch {
    throw new SpreadsheetError("The file is not a readable .xlsx spreadsheet.");
  }
  if (rows.length > MAX_ROWS) throw new SpreadsheetError(`The spreadsheet has more than ${MAX_ROWS} rows.`, true);
  if (rows.some((row) => row.length > MAX_COLUMNS)) {
    throw new SpreadsheetError(`The spreadsheet has more than ${MAX_COLUMNS} columns.`, true);
  }
  return rows as SheetRow[];
}

/** Build a one-sheet .xlsx from rows of plain values (header first). Header cells are bold. */
export async function writeSheet(rows: readonly (readonly (string | number)[])[]): Promise<Buffer> {
  const sheet = rows.map((row, index) =>
    row.map((value) => (index === 0 ? { value, fontWeight: "bold" as const } : { value })),
  );
  return writeXlsxFile(sheet).toBuffer();
}
