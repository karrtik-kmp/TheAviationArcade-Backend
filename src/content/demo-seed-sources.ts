import { readdir } from "node:fs/promises";
import path from "node:path";
import { validInstagram } from "./editorial/editorial-rules.js";
import { readRegularFile } from "./media/media-import.js";
import type { SheetRow } from "./xlsx.js";

/**
 * The read-only side of the dev demo seed (docs/plans/demo-seed.md, section S4 and G): finding the client's files, reading the Plane
 * of the Day sheet, and matching a sheet's file name to a photo file. Nothing here touches the database, and nothing here writes
 * a file. The folders are the user's copy of the client deliveries and are never changed.
 */

export const MILITARY_SHEET = "Military Airplane Identifier v1.xlsx";
export const IDENTIFIER_SHEET = "Airplane Identifier v1.xlsx";
export const POTD_SHEET = "Airplane Games - Game Play.xlsx";
const MILITARY_FOLDER_PREFIX = "Military Airplane Identifier - Pictures";
const IDENTIFIER_FOLDER_PREFIX = "Airplane Identifier-";
const POTD_FOLDER_PREFIX = "Plane of the Day-";
/** A client workbook is a few KB; this is the import route's own cap. */
export const MAX_SHEET_BYTES = 5 * 1024 * 1024;

export type SeedKind = "mil" | "ai" | "potd";

export type SeedSources = {
  military: { sheet: string; photoDir: string };
  identifier: { sheet: string; photoDir: string };
  potd: { sheet: string; photoDir: string };
};

export type Discovery = { ok: true; sources: SeedSources } | { ok: false; error: string };

async function entries(dir: string) {
  return readdir(dir, { withFileTypes: true });
}

/** The one real (not linked) directory in `parent` whose name starts with `prefix`. */
async function oneFolder(parent: string, prefix: string, what: string): Promise<{ ok: true; dir: string } | { ok: false; error: string }> {
  let list;
  try {
    list = await entries(parent);
  } catch {
    return { ok: false, error: `${parent} is not a readable folder.` };
  }
  const found = list.filter((e) => e.isDirectory() && e.name.startsWith(prefix));
  if (found.length === 0) return { ok: false, error: `${what}: no folder starting "${prefix}" in ${parent}.` };
  if (found.length > 1) return { ok: false, error: `${what}: more than one folder starting "${prefix}" in ${parent} (${found.map((e) => e.name).join(", ")}).` };
  return { ok: true, dir: path.join(parent, (found[0] as { name: string }).name) };
}

/** The one real directory inside `dir` (the archive's inner folder). */
async function onlySubfolder(dir: string, what: string): Promise<{ ok: true; dir: string } | { ok: false; error: string }> {
  let list;
  try {
    list = await entries(dir);
  } catch {
    return { ok: false, error: `${dir} is not a readable folder.` };
  }
  const found = list.filter((e) => e.isDirectory());
  if (found.length !== 1) return { ok: false, error: `${what}: ${dir} should hold exactly one inner folder, it holds ${found.length}.` };
  return { ok: true, dir: path.join(dir, (found[0] as { name: string }).name) };
}

async function plainFile(dir: string, name: string): Promise<{ ok: true; file: string } | { ok: false; error: string }> {
  let list;
  try {
    list = await entries(dir);
  } catch {
    return { ok: false, error: `${dir} is not a readable folder.` };
  }
  return list.some((e) => e.isFile() && e.name === name) ? { ok: true, file: path.join(dir, name) } : { ok: false, error: `${name} is not in ${dir}.` };
}

/**
 * Find the three sheets and three photo folders, read-only. `docs` holds the Military sheet and its Pictures folder; `delivery` is
 * the 2026-09-28 folder with the Identifier sheet, the Plane of the Day sheet and their folders. Any miss or ambiguity is an error
 * naming what was expected; nothing is guessed.
 */
export async function discoverSources(docs: string, delivery: string): Promise<Discovery> {
  const milSheet = await plainFile(docs, MILITARY_SHEET);
  if (!milSheet.ok) return milSheet;
  const milOuter = await oneFolder(docs, MILITARY_FOLDER_PREFIX, "Military photos");
  if (!milOuter.ok) return milOuter;
  const milInner = await onlySubfolder(milOuter.dir, "Military photos");
  if (!milInner.ok) return milInner;

  const aiSheet = await plainFile(delivery, IDENTIFIER_SHEET);
  if (!aiSheet.ok) return aiSheet;
  const aiOuter = await oneFolder(delivery, IDENTIFIER_FOLDER_PREFIX, "Identifier photos");
  if (!aiOuter.ok) return aiOuter;
  const aiInner = await onlySubfolder(aiOuter.dir, "Identifier photos");
  if (!aiInner.ok) return aiInner;

  const potdSheet = await plainFile(delivery, POTD_SHEET);
  if (!potdSheet.ok) return potdSheet;
  const potdOuter = await oneFolder(delivery, POTD_FOLDER_PREFIX, "Plane of the Day photos");
  if (!potdOuter.ok) return potdOuter;
  const potdInner = await onlySubfolder(potdOuter.dir, "Plane of the Day photos");
  if (!potdInner.ok) return potdInner;

  return {
    ok: true,
    sources: {
      military: { sheet: milSheet.file, photoDir: milInner.dir },
      identifier: { sheet: aiSheet.file, photoDir: aiInner.dir },
      potd: { sheet: potdSheet.file, photoDir: potdInner.dir },
    },
  };
}

const IMAGE_EXTENSION = /\.(jpe?g|png)$/i;
export const isImageName = (name: string): boolean => IMAGE_EXTENSION.test(name);

/** The image files (.jpg, .jpeg, .png; regular files only) of a folder, in natural order, and the other names that were ignored. */
export async function listPhotoFiles(dir: string): Promise<{ files: string[]; ignored: string[] }> {
  const list = await entries(dir);
  const files: string[] = [];
  const ignored: string[] = [];
  for (const e of list) (e.isFile() && isImageName(e.name) ? files : ignored).push(e.name);
  const natural = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });
  return { files: files.sort(natural), ignored: ignored.sort(natural) };
}

/** A sheet file's bytes, read without following a link and within the size cap. */
export async function readSheetFile(file: string): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; error: string }> {
  const read = await readRegularFile(file, MAX_SHEET_BYTES);
  return read.ok ? { ok: true, bytes: read.bytes } : { ok: false, error: `${path.basename(file)}: ${read.detail}` };
}

// ---- photo matching ----

export type PhotoMatch =
  | { kind: "exact"; file: string }
  | { kind: "case_insensitive"; file: string }
  | { kind: "extension"; file: string }
  | { kind: "ambiguous"; files: string[] }
  | { kind: "none" };

const fold = (value: string): string => value.normalize("NFC").toLowerCase();
/** The name without a trailing `.<letters or digits>` (any extension, known or not: a typo such as `.jpog` is stripped too). */
const stemOf = (name: string): string => name.replace(/\.[A-Za-z0-9]{1,6}$/, "");

/**
 * Find the photo file a sheet row names: the exact name; else the same name ignoring case; else, when the row has no image extension
 * (none at all, or a typo such as `.jpog`), the file with the same stem and an image extension. Each step must find exactly one
 * file: two candidates are `ambiguous` and nothing is chosen. The caller reports every non-exact match.
 */
export function matchPhoto(wanted: string, files: readonly string[]): PhotoMatch {
  const name = wanted.normalize("NFC").trim();
  if (name === "") return { kind: "none" };
  const exact = files.filter((f) => f.normalize("NFC") === name);
  if (exact.length === 1) return { kind: "exact", file: exact[0] as string };
  const folded = files.filter((f) => fold(f) === fold(name));
  if (folded.length === 1) return { kind: "case_insensitive", file: folded[0] as string };
  if (folded.length > 1) return { kind: "ambiguous", files: folded };
  if (!isImageName(name)) {
    const stem = fold(stemOf(name));
    const byStem = files.filter((f) => isImageName(f) && fold(stemOf(f)) === stem);
    if (byStem.length === 1) return { kind: "extension", file: byStem[0] as string };
    if (byStem.length > 1) return { kind: "ambiguous", files: byStem };
  }
  return { kind: "none" };
}

// ---- Plane of the Day sheet ----

export type PotdEntry = {
  /** Sheet row (1-based). */
  row: number;
  /** The "Image #" value, e.g. `pod-4`. */
  image: string;
  title: string;
  /** Manufacturer and Model, trimmed, non-empty parts joined by one space. */
  aircraft: string;
  photographer: string;
  /** The Instagram cell as written when it is a valid handle or https link, else "". */
  instagram: string;
  /** The Instagram handle without `@`, "" when there is none. */
  handle: string;
  description: string;
};

export type PotdIssue = { row: number; message: string };
export type PotdParse = { ok: true; entries: PotdEntry[]; issues: PotdIssue[] } | { ok: false; error: string };

/** A cell as written: text trimmed; a number as its plain decimal (737, never 737.0); anything else empty. */
export function cellText(cell: unknown): string {
  if (typeof cell === "string") return cell.trim();
  if (typeof cell === "number" && Number.isFinite(cell)) return String(cell);
  return "";
}

const HANDLE = /^[A-Za-z0-9._]{1,30}$/;

/** The handle behind an Instagram cell (`@name`, or an https instagram.com/<name> link), "" when none can be read. */
export function instagramHandle(value: string): string {
  const text = value.trim();
  if (/^@[A-Za-z0-9._]{1,30}$/.test(text)) return text.slice(1);
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" || !/(^|\.)instagram\.com$/i.test(url.hostname)) return "";
    const first = url.pathname.split("/").filter((part) => part !== "")[0] ?? "";
    return HANDLE.test(first) ? first : "";
  } catch {
    return "";
  }
}

/** The credit shown for a Plane of the Day photo: the row's Photographer plus ` (@handle)`; "" when the row names no photographer. */
export function potdCredit(entry: Pick<PotdEntry, "photographer" | "handle">): string {
  if (entry.photographer === "") return "";
  return entry.handle === "" ? entry.photographer : `${entry.photographer} (@${entry.handle})`;
}

const POTD_COLUMNS = ["image #", "title", "manufacturer", "model", "description", "photographer", "instagram"] as const;

/**
 * Read the client's Plane of the Day sheet ("Airplane Games - Game Play.xlsx"): the header row (the one with "Image #", found in
 * the first 10 rows), then one entry per row with an Image #. Values are as written, trimmed. A repeated Image # keeps the first row.
 */
export function parsePlaneOfTheDay(rows: readonly SheetRow[]): PotdParse {
  let headerAt = -1;
  for (let i = 0; i < Math.min(rows.length, 10); i += 1) {
    if ((rows[i] ?? []).some((c) => cellText(c).toLowerCase() === "image #")) {
      headerAt = i;
      break;
    }
  }
  if (headerAt < 0) return { ok: false, error: 'The Plane of the Day sheet has no header row with "Image #" in its first 10 rows.' };
  const columns = new Map<string, number>();
  (rows[headerAt] ?? []).forEach((c, index) => {
    const key = cellText(c).toLowerCase();
    if (key !== "" && !columns.has(key)) columns.set(key, index);
  });
  const missing = POTD_COLUMNS.filter((name) => !columns.has(name));
  if (missing.length > 0) return { ok: false, error: `The Plane of the Day sheet has no column named ${missing.map((m) => `"${m}"`).join(", ")}.` };
  const at = (row: SheetRow, name: (typeof POTD_COLUMNS)[number]): string => cellText(row[columns.get(name) as number]);

  const entriesOut: PotdEntry[] = [];
  const issues: PotdIssue[] = [];
  const seen = new Set<string>();
  for (let i = headerAt + 1; i < rows.length; i += 1) {
    const row = rows[i] ?? [];
    const sheetRow = i + 1;
    const image = at(row, "image #");
    if (image === "") continue;
    if (seen.has(image.toLowerCase())) {
      issues.push({ row: sheetRow, message: `Image # "${image}" appears again; the later row is left out.` });
      continue;
    }
    seen.add(image.toLowerCase());
    const instagramCell = at(row, "instagram");
    let instagram = instagramCell;
    if (!validInstagram(instagram)) {
      issues.push({ row: sheetRow, message: `Instagram "${instagramCell}" is not a handle or an https link; left empty.` });
      instagram = "";
    }
    const handle = instagramHandle(instagram);
    if (instagram !== "" && handle === "") issues.push({ row: sheetRow, message: "No Instagram handle can be read from the link; the credit has no @handle." });
    entriesOut.push({
      row: sheetRow,
      image,
      title: at(row, "title"),
      aircraft: [at(row, "manufacturer"), at(row, "model")].filter((part) => part !== "").join(" "),
      photographer: at(row, "photographer"),
      instagram,
      handle,
      description: at(row, "description"),
    });
  }
  return { ok: true, entries: entriesOut, issues };
}
