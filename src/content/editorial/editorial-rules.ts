import { EDITORIAL_KINDS } from "../../db/enums.js";
import type { EditorialKind, EditorialStatus } from "../../db/enums.js";
import { isRank } from "../../rules/ranks.js";

/**
 * Pure rules of the staff editorial desks (docs/plans/website-content.md §1.3): a port of the website's `lib/rules.ts`
 * (`validDate`, `editorialErrors`) and its desk save checks. Nothing here touches the database, and nothing generates or prefills
 * a question, answer, hint or fact: the backend validates and stores only what staff typed.
 */

export { EDITORIAL_KINDS };

/** Every string field of `data` is at most this many code points. */
export const EDITORIAL_TEXT_MAX = 2400;
/** An Identifier item has the correct answer and exactly this many distractors. */
export const DISTRACTOR_COUNT = 3;
/** The most items a desk list returns (ASSUMPTION: no paging yet). */
export const EDITORIAL_LIST_LIMIT = 200;

export type EditorialData = {
  title: string;
  aircraft: string;
  photographer: string;
  instagram: string;
  /** Staff-typed credit. NEVER public: the one public attribution is the media version's `licence.credit`. */
  credit: string;
  description: string;
  correctAnswer: string;
  distractors: string[];
  /** "" or the item's Rank (a backend rank id). */
  difficulty: string;
  factualSource: string;
};

const TEXT_FIELDS = ["title", "aircraft", "photographer", "instagram", "credit", "description", "correctAnswer", "difficulty", "factualSource"] as const;
/** The keys of `data`, in the order they are stored. */
export const EDITORIAL_DATA_KEYS = [
  "title",
  "aircraft",
  "photographer",
  "instagram",
  "credit",
  "description",
  "correctAnswer",
  "distractors",
  "difficulty",
  "factualSource",
] as const;

export function isEditorialKind(value: string): value is EditorialKind {
  return (EDITORIAL_KINDS as readonly string[]).includes(value);
}

/** The shape a create without `data` stores. Nothing is prefilled from the media. */
export function blankEditorialData(): EditorialData {
  return {
    title: "",
    aircraft: "",
    photographer: "",
    instagram: "",
    credit: "",
    description: "",
    correctAnswer: "",
    distractors: ["", "", ""],
    difficulty: "",
    factualSource: "",
  };
}

const codePoints = (text: string): number => [...text].length;
// Every control character (C0, DEL, C1) except the line feed. CRLF is turned into LF before this runs.
const FORBIDDEN_CONTROL = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/;
const INSTAGRAM_HANDLE = /^@?[A-Za-z0-9._]{1,30}$/;

/** A handle (`@name`, 1-30 of letters, digits, `.`, `_`) or an https URL. The empty string means "none". */
export function validInstagram(value: string): boolean {
  if (value === "") return true;
  if (INSTAGRAM_HANDLE.test(value)) return true;
  if (!value.startsWith("https://") || /\s/.test(value)) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/** A real calendar date `YYYY-MM-DD` (2026-02-29 is refused). Port of the website's `validDate`. */
export function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

/**
 * Check and normalise one `data` value: CRLF becomes LF, text is trimmed on store (ASSUMPTION), and every problem is collected
 * (never just the first). `data` is null when there is any error. An unknown key is an error here too (the HTTP schema already
 * refuses one with 400), so `imageUrl` can never be stored.
 */
export function normaliseEditorialData(input: unknown): { data: EditorialData | null; errors: string[] } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { data: null, errors: ["data must be an object."] };
  }
  const errors: string[] = [];
  const raw = input as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!(EDITORIAL_DATA_KEYS as readonly string[]).includes(key)) errors.push(`data.${key} is not a field of an editorial item.`);
  }
  const clean = (label: string, value: unknown): string => {
    if (typeof value !== "string") {
      errors.push(`${label} must be text.`);
      return "";
    }
    const text = value.replace(/\r\n/g, "\n");
    if (FORBIDDEN_CONTROL.test(text)) errors.push(`${label} must not contain control characters (line breaks are allowed).`);
    const trimmed = text.trim();
    if (codePoints(trimmed) > EDITORIAL_TEXT_MAX) errors.push(`${label} is longer than ${EDITORIAL_TEXT_MAX} characters.`);
    return trimmed;
  };
  const out = blankEditorialData();
  for (const field of TEXT_FIELDS) out[field] = clean(`data.${field}`, raw[field]);
  const distractors = raw.distractors;
  if (!Array.isArray(distractors) || distractors.length !== DISTRACTOR_COUNT) {
    errors.push(`data.distractors must be exactly ${DISTRACTOR_COUNT} texts.`);
    out.distractors = ["", "", ""];
  } else {
    out.distractors = distractors.map((d, i) => clean(`data.distractors[${i}]`, d));
  }
  if (!validInstagram(out.instagram)) errors.push("data.instagram must be empty, a handle such as @name (up to 30 letters, digits, dots or underscores) or an https link.");
  if (out.difficulty !== "" && !isRank(out.difficulty)) errors.push("data.difficulty must be empty or a rank (trainee, first-officer, captain, check-airman, chief-pilot).");
  return errors.length > 0 ? { data: null, errors } : { data: out, errors };
}

/** `dateKey` on its own: an Identifier item has none; a Plane of the Day item has none or a real calendar date. */
export function dateKeyErrors(kind: EditorialKind, dateKey: string | null): string[] {
  if (dateKey === null) return [];
  if (kind === "identifier") return ["An Aircraft Identifier item has no date."];
  return validDate(dateKey) ? [] : ["dateKey must be a real calendar date (YYYY-MM-DD)."];
}

/**
 * What a `scheduled` or `published` item needs beyond the shape (website `editorialErrors` plus the desk save checks). Every
 * unmet rule is listed. The photo rules (published, not demo-owned, licence credit set) need the database and are the service's.
 */
export function publishErrors(kind: EditorialKind, status: EditorialStatus, data: EditorialData, dateKey: string | null): string[] {
  if (status !== "scheduled" && status !== "published") return [];
  const errors: string[] = [];
  if (codePoints(data.title.trim()) < 3) errors.push("Add a descriptive title (at least 3 characters).");
  if (!data.factualSource.startsWith("https://")) errors.push("Add an https factual source.");
  if (kind === "identifier") {
    if (status === "scheduled") errors.push("Aircraft Identifier supports draft or published content, not daily scheduling.");
    const options = [data.correctAnswer, ...data.distractors].map((s) => s.trim().toLowerCase());
    if (options.some((s) => s === "")) errors.push("Provide one correct answer and three distractors.");
    if (new Set(options).size !== options.length) errors.push("All answer choices must be different.");
    if (!isRank(data.difficulty)) errors.push("Choose a supported rank for the difficulty.");
  } else {
    if (codePoints(data.description.trim()) < 15) errors.push("Add the photo's factual context (at least 15 characters).");
    if (dateKey === null) errors.push("Choose the date this Plane of the Day is for.");
  }
  return errors;
}

/** The names of the `data` fields that differ, in storage order. */
export function changedFields(before: EditorialData, after: EditorialData): string[] {
  return EDITORIAL_DATA_KEYS.filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
}

/** `ed-<n>`: the wire form of an editorial item id. */
export const EDITORIAL_ID_PATTERN = /^ed-([1-9][0-9]{0,14})$/;

export function formatEditorialId(id: number): string {
  return `ed-${id}`;
}

/** `ed-<n>` to its number; undefined when the text is not strictly that form. */
export function parseEditorialId(value: string): number | undefined {
  const match = EDITORIAL_ID_PATTERN.exec(value);
  return match ? Number(match[1]) : undefined;
}
