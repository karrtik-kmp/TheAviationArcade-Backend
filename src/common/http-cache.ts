/**
 * RFC 9110 `If-None-Match` for a GET: `*` matches any current representation, otherwise any listed tag equal to `etag`
 * under WEAK comparison (a `W/` prefix is ignored) matches. `etag` is the quoted strong tag we sent.
 */
export function ifNoneMatchHits(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  const value = header.trim();
  if (value === "*") return true;
  return value.split(",").some((part) => part.trim().replace(/^W\//, "") === etag);
}
