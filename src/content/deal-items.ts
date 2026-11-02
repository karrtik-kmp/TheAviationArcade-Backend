import type { DealItem } from "../rules/dealer.js";
import { isRank } from "../rules/ranks.js";

/** The stored columns the dealer needs. */
export type DealRow = { id: string; rank: string; data: unknown };

/**
 * Map a stored content row to a dealable item, or undefined when the row cannot be dealt at all (an unknown
 * rank, or a payload that is not `{ answer, wrong[3], sourceFile }` of strings, with three non-empty wrong
 * answers; a stored row can only be like that if it was edited outside the importer). Military payload: `answer`,
 * `wrong[3]`, and `sourceFile` as the photo identity. A blank `sourceFile` still maps (to a blank `photoKey`),
 * and `dealablePool` inside `tripCoverage` then leaves it out: the row is simply not dealable.
 */
export function rowToDealItem(row: DealRow): DealItem | undefined {
  if (!isRank(row.rank)) return undefined;
  const data = row.data;
  if (!data || typeof data !== "object") return undefined;
  const { answer, wrong, sourceFile } = data as Record<string, unknown>;
  if (typeof answer !== "string" || typeof sourceFile !== "string") return undefined;
  if (!Array.isArray(wrong) || wrong.length !== 3 || !wrong.every((w) => typeof w === "string" && w !== "")) return undefined;
  const [w1, w2, w3] = wrong as [string, string, string];
  return { id: row.id, rank: row.rank, photoKey: sourceFile.trim().normalize("NFC"), answer, wrong: [w1, w2, w3] };
}
