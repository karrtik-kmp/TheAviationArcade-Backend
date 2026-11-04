import { z } from "zod";

export const MEDIA_ID = /^med-([1-9][0-9]{0,14})$/;
export const MAX_IDS = 50;

/**
 * `?ids=med-1,med-2`: one parameter (a repeated one arrives as an array and fails), 1 to 50 comma-separated strict ids as sent.
 * Duplicates are collapsed, keeping the first position. Unknown parameters are refused.
 */
export const idsQuery = z
  .strictObject({
    ids: z
      .string()
      .transform((s) => s.split(","))
      .pipe(z.array(z.string().regex(MEDIA_ID)).min(1).max(MAX_IDS)),
  })
  .transform((q) => [...new Set(q.ids.map((id) => Number(MEDIA_ID.exec(id)![1])))]);

export const IDS_QUERY_MESSAGE = "Expected only ?ids=med-1,med-2,... with 1 to 50 media ids, each med-<n>, in one parameter.";
