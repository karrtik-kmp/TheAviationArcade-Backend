// Pure image sniffer: decides JPEG vs PNG from the bytes alone and reads the pixel size from the header.
// Never trust a file name or a declared content type; callers compare the sniffed type themselves.
// Every read is bounds-checked, so truncated or hostile input returns `{ ok: false }` and never throws.

export const MAX_IMAGE_SIDE = 4096;

export type SniffResult =
  | { ok: true; contentType: "image/jpeg" | "image/png"; width: number; height: number }
  | { ok: false; reason: string };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function fail(reason: string): SniffResult {
  return { ok: false, reason };
}

function checkSize(contentType: "image/jpeg" | "image/png", width: number, height: number): SniffResult {
  if (width === 0 || height === 0) return fail("image has a zero width or height");
  if (width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE) {
    return fail(`image is ${width}x${height}; each side must be at most ${MAX_IMAGE_SIDE} px`);
  }
  return { ok: true, contentType, width, height };
}

function u32(b: Uint8Array, o: number): number {
  return ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
}

function u16(b: Uint8Array, o: number): number {
  return (b[o]! << 8) | b[o + 1]!;
}

const PNG_IEND = [0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]; // length 0, "IEND", CRC

function sniffPng(b: Uint8Array): SniffResult {
  // signature (8) + length (4) + "IHDR" (4) + width (4) + height (4)
  if (b.length < 24) return fail("PNG is truncated before the IHDR chunk ends");
  if (u32(b, 8) !== 13) return fail("PNG first chunk is not a 13-byte IHDR");
  if (b[12] !== 0x49 || b[13] !== 0x48 || b[14] !== 0x44 || b[15] !== 0x52) {
    return fail("PNG first chunk is not IHDR");
  }
  const size = checkSize("image/png", u32(b, 16), u32(b, 20));
  if (!size.ok) return size;
  // IHDR is 25 bytes in total (length, type, 13 data, CRC); a complete file ends with the 12-byte IEND chunk after it.
  if (b.length < 33 + PNG_IEND.length) return fail("PNG is truncated (no complete IEND chunk)");
  const tail = b.length - PNG_IEND.length;
  if (!PNG_IEND.every((v, k) => b[tail + k] === v)) return fail("PNG is truncated or does not end with an IEND chunk");
  return size;
}

function isSof(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function unsupportedProcess(marker: number): string {
  if (marker === 0xc3 || marker === 0xcb) return "lossless JPEG is not supported";
  if (marker >= 0xc5 && marker <= 0xc7) return "hierarchical JPEG is not supported";
  if (marker >= 0xc9 && marker <= 0xcf) return "arithmetic-coded JPEG is not supported";
  return "JPEG coding process is not supported (only baseline and progressive Huffman)";
}

function sniffJpeg(b: Uint8Array): SniffResult {
  let i = 2;
  let size: SniffResult | undefined;
  let scanStart = -1;
  while (i < b.length) {
    if (b[i] !== 0xff) return fail("JPEG has bytes where a marker was expected");
    while (i < b.length && b[i] === 0xff) i++; // fill bytes
    if (i >= b.length) break;
    const marker = b[i]!;
    i++;
    if (marker === 0x00) return fail("JPEG has an invalid marker");
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue; // TEM, RST0-7, SOI: no length
    if (marker === 0xd9) return fail(size ? "JPEG ended (EOI) before a scan" : "JPEG ended (EOI) before a frame header");
    if (i + 2 > b.length) break;
    const length = u16(b, i);
    if (length < 2) return fail("JPEG segment length is invalid");
    if (isSof(marker)) {
      if (size) return fail("JPEG has more than one frame header");
      // only baseline (SOF0), extended sequential Huffman (SOF1) and progressive Huffman (SOF2)
      if (marker > 0xc2) return fail(unsupportedProcess(marker));
      // length(2) precision(1) height(2) width(2)
      if (length < 7 || i + 7 > b.length) break;
      if (b[i + 2] !== 8) return fail(`JPEG sample precision is ${b[i + 2]} bits; only 8 is supported`);
      size = checkSize("image/jpeg", u16(b, i + 5), u16(b, i + 3));
      if (!size.ok) return size;
    } else if (marker === 0xda) {
      if (!size) return fail("JPEG scan started before a frame header");
      scanStart = i;
      break;
    }
    i += length;
  }
  if (!size) return fail("JPEG is truncated before a frame header");
  if (scanStart < 0) return fail("JPEG is truncated before a scan (no SOS marker)");
  // Entropy-coded data stuffs every FF as FF 00 and restart markers are FF D0-D7, so the first FF D9 after the scan
  // starts is the real EOI. Bytes after it are allowed: phone cameras append data there (e.g. MPF extra images).
  for (let k = scanStart; k + 1 < b.length; k++) {
    if (b[k] === 0xff && b[k + 1] === 0xd9) return size;
  }
  return fail("JPEG is truncated (no EOI after the scan)");
}

export function sniffImage(bytes: Uint8Array): SniffResult {
  if (bytes.length >= 8 && PNG_SIGNATURE.every((v, k) => bytes[k] === v)) return sniffPng(bytes);
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return sniffJpeg(bytes);
  if (bytes.length >= 8 && PNG_SIGNATURE.slice(0, 4).every((v, k) => bytes[k] === v)) return fail("PNG signature is damaged");
  return fail("not a JPEG or PNG image");
}
