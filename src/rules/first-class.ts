/** A First Class Pass applies strictly before it expires: a pass expiring exactly at `now` does not apply. */
export function hasFirstClassPass(firstClassUntil: Date | null, now: Date): boolean {
  return firstClassUntil !== null && firstClassUntil.getTime() > now.getTime();
}
