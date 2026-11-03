/** The public form of a media id (`med-<n>`) as content items carry it. Mirrors the `{mediaId}` rule of the media routes. */
export const MEDIA_ID_PATTERN = /^med-([1-9][0-9]{0,14})$/;

export function formatMediaId(id: number | null): string | null {
  return id === null ? null : `med-${id}`;
}

/** `med-<n>` to its number; undefined when the text is not strictly that form. */
export function parseMediaId(value: string): number | undefined {
  const match = MEDIA_ID_PATTERN.exec(value);
  return match ? Number(match[1]) : undefined;
}
