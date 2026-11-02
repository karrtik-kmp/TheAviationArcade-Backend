import { createHash } from "node:crypto";

/**
 * THE canonical serialisation of a published content document (design 7; slice T4). One definition, used for the stored
 * `sha256` / `byte_size`, for the bytes the route serves and for the manifest. jsonb keeps neither key order nor
 * whitespace, so the bytes are never stored: they are rebuilt from the stored value by this function, and every read
 * re-checks them against the stored digest.
 *
 * Rules (a strict subset of RFC 8785, so any JSON library can reproduce them):
 *  - UTF-8, no byte order mark, no whitespace between tokens, no trailing newline.
 *  - Object keys sorted in UTF-16 code unit order, at every depth. Array order is kept.
 *  - Values: null, booleans, strings, SAFE INTEGERS (no fractions, no exponents, no -0), arrays, plain objects.
 *    Anything else (undefined, NaN, a fraction, a bigint, a Date, a lone surrogate, U+0000) throws: jsonb cannot hold a
 *    U+0000 and a lone surrogate would not survive UTF-8, so such a value could never round-trip through the table.
 *  - Strings use JSON.stringify's escaping (`"`, `\`, control characters as \b \f \n \r \t or \u00XX in lower case;
 *    everything else, including non-ASCII, is written as is).
 */
export class CanonicalJsonError extends Error {}

/** A lone surrogate does not survive UTF-8 (ES2024 String.isWellFormed, spelled out for the ES2023 lib). */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function fail(path: string, why: string): never {
  throw new CanonicalJsonError(`${path || "$"}: ${why}`);
}

function write(value: unknown, path: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string": {
      if (LONE_SURROGATE.test(value)) fail(path, "string has a lone surrogate");
      if (value.includes("\u0000")) fail(path, "string contains U+0000");
      return JSON.stringify(value);
    }
    case "number": {
      if (!Number.isSafeInteger(value) || Object.is(value, -0)) fail(path, `number ${String(value)} is not a safe integer`);
      return String(value);
    }
    case "object": {
      if (Array.isArray(value)) return `[${value.map((item, i) => write(item, `${path}[${i}]`)).join(",")}]`;
      const proto = Object.getPrototypeOf(value) as unknown;
      if (proto !== Object.prototype && proto !== null) fail(path, "not a plain object");
      const record = value as Record<string, unknown>;
      const parts: string[] = [];
      for (const key of Object.keys(record).sort()) {
        if (LONE_SURROGATE.test(key) || key.includes("\u0000")) fail(path, "key has a lone surrogate or U+0000");
        parts.push(`${JSON.stringify(key)}:${write(record[key], `${path}.${key}`)}`);
      }
      return `{${parts.join(",")}}`;
    }
    default:
      return fail(path, `${typeof value} is not a JSON value`);
  }
}

export function canonicalJson(value: unknown): string {
  return write(value, "");
}

export function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value), "utf8");
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
