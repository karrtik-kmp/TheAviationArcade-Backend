import { createHash } from "node:crypto";
import { z } from "zod";
import { ApiError } from "../../common/errors.js";

// Photo submission v2 (docs/plans/photo-submission-v2.md): the X-Submission header decoder (D2), the field rules shared with the
// rights and edit bodies, and the normalised digest an upload key is compared on (D10). No message here ever echoes a value.

export const SUBMISSION_HEADER_MAX = 6144;

// Text is trimmed and otherwise kept verbatim; control characters and lone surrogates are refused. Lengths count code points, as
// Postgres length() does.
const CONTROL = /\p{Cc}/u;
// String.prototype.isWellFormed (Node >= 20) is ES2024; the tsconfig lib stops at ES2023, hence the cast.
const wellFormed = (s: string): boolean => (s as string & { isWellFormed(): boolean }).isWellFormed();
const codePoints = (s: string) => [...s].length;
export const text = (min: number, max: number) =>
  z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().refine((s) => wellFormed(s) && codePoints(s) >= min && codePoints(s) <= max && !CONTROL.test(s)));

const HANDLE = /^[A-Za-z0-9._]{1,30}$/;

/** Trimmed, one leading `@` stripped; empty (or `@` alone) means none (null). Anything else must be a valid handle. */
export const instagramHandle = z.string().transform((raw, ctx): string | null => {
  const trimmed = raw.trim();
  const handle = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  if (handle === "") return null;
  if (!HANDLE.test(handle)) {
    ctx.addIssue({ code: "custom", message: "invalid instagram handle" });
    return z.NEVER;
  }
  return handle;
});

/** What a v2 submission holds once validated and normalised (D2). */
export type Submission = {
  fullName: string;
  title: string;
  credit: string;
  instagramHandle: string | null;
  instagramDisplayConsent: boolean;
};

/** The submission object: the X-Submission payload and the `submission` of a v2 `PUT .../rights` body. */
export const submissionSchema = z
  .strictObject({
    fullName: text(1, 200),
    title: text(1, 200),
    credit: text(1, 200),
    instagramHandle: instagramHandle.nullish(),
    instagramDisplayConsent: z.boolean().optional(),
  })
  .transform((value, ctx): Submission => {
    const handle = value.instagramHandle ?? null;
    const consent = value.instagramDisplayConsent ?? false;
    if (consent && handle === null) {
      ctx.addIssue({ code: "custom", message: "consent needs a handle" });
      return z.NEVER;
    }
    return { fullName: value.fullName, title: value.title, credit: value.credit, instagramHandle: handle, instagramDisplayConsent: consent };
  });

const badHeader = () =>
  new ApiError(
    400,
    "invalid_request",
    "Expected an X-Submission header: base64url (no padding) of UTF-8 JSON { fullName, title, credit, instagramHandle?, instagramDisplayConsent? }, at most 6144 characters, text without control characters and nothing else.",
  );

/**
 * Decode the X-Submission header (D2 steps 1 to 5). Every failure is the same 400 `invalid_request` and never says which value was wrong:
 * (1) length and alphabet (a header sent twice is joined with ", " and fails here), (2) canonical base64url, (3) strict UTF-8 with a
 * BOM kept (so JSON.parse refuses it), (4) a JSON object with exactly the known keys and valid fields, (5) every string well formed.
 */
export function decodeSubmissionHeader(value: string): Submission {
  if (value.length < 1 || value.length > SUBMISSION_HEADER_MAX || !/^[A-Za-z0-9_-]+$/.test(value)) throw badHeader();
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) throw badHeader();
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw badHeader();
  }
  let json: unknown;
  try {
    json = JSON.parse(decoded);
  } catch {
    throw badHeader();
  }
  const parsed = submissionSchema.safeParse(json);
  if (!parsed.success) throw badHeader();
  return parsed.data;
}

/**
 * sha256 of JSON.stringify of the normalised submission in a FIXED key order with defaults written out (D10): the same intent
 * gives the same digest however the client ordered its JSON keys or spelled the handle.
 */
export function submissionDigest(s: Submission): string {
  const ordered = {
    fullName: s.fullName,
    title: s.title,
    credit: s.credit,
    instagramHandle: s.instagramHandle,
    instagramDisplayConsent: s.instagramDisplayConsent,
  };
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}
