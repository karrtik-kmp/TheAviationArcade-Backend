import { describe, expect, it } from "vitest";
import { MAX_IMAGE_SIDE, sniffImage } from "../src/content/media/image-sniff.js";

const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const be16 = (n: number) => [(n >> 8) & 255, n & 255];

function png(w: number, h: number, firstChunk = "IHDR"): Uint8Array {
  const type = [...firstChunk].map((c) => c.charCodeAt(0));
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...be32(13), ...type, ...be32(w), ...be32(h), 8, 2, 0, 0, 0, 0, 0, 0, 0,
    ...be32(0), 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
}

function jpeg(w: number, h: number, opts: { sof?: number; pre?: number[]; precision?: number } = {}): Uint8Array {
  const sof = opts.sof ?? 0xc0;
  return Uint8Array.from([
    0xff, 0xd8,
    ...(opts.pre ?? []),
    0xff, sof, ...be16(11), opts.precision ?? 8, ...be16(h), ...be16(w), 1, 1, 0x11, 0,
    0xff, 0xda, ...be16(4), 0, 0, 1, 2, 3, 0xff, 0xd9,
  ]);
}

describe("sniffImage", () => {
  it("reads a PNG", () => {
    expect(sniffImage(png(640, 480))).toEqual({ ok: true, contentType: "image/png", width: 640, height: 480 });
  });

  it("reads a baseline JPEG (height before width in the file)", () => {
    expect(sniffImage(jpeg(640, 480))).toEqual({ ok: true, contentType: "image/jpeg", width: 640, height: 480 });
  });

  it("reads a progressive JPEG (SOF2)", () => {
    expect(sniffImage(jpeg(100, 50, { sof: 0xc2 }))).toEqual({ ok: true, contentType: "image/jpeg", width: 100, height: 50 });
  });

  it("skips APPn, COM, fill bytes and standalone markers before SOF", () => {
    const app0 = [0xff, 0xe0, ...be16(6), 1, 2, 3, 4];
    const com = [0xff, 0xfe, ...be16(5), 65, 66, 67];
    const pre = [...app0, 0xff, 0xff, 0xff, ...com, 0xff, 0xd0, 0xff, 0x01];
    expect(sniffImage(jpeg(33, 22, { pre }))).toEqual({ ok: true, contentType: "image/jpeg", width: 33, height: 22 });
  });

  it("accepts the maximum side and rejects one more", () => {
    expect(sniffImage(png(MAX_IMAGE_SIDE, MAX_IMAGE_SIDE)).ok).toBe(true);
    expect(sniffImage(jpeg(MAX_IMAGE_SIDE, 10)).ok).toBe(true);
    expect(sniffImage(png(MAX_IMAGE_SIDE + 1, 10)).ok).toBe(false);
    expect(sniffImage(png(10, MAX_IMAGE_SIDE + 1)).ok).toBe(false);
    expect(sniffImage(jpeg(MAX_IMAGE_SIDE + 1, 10)).ok).toBe(false);
    expect(sniffImage(jpeg(10, MAX_IMAGE_SIDE + 1)).ok).toBe(false);
    expect(sniffImage(png(0xffffffff, 10)).ok).toBe(false);
  });

  it("rejects zero sides", () => {
    for (const bytes of [png(0, 10), png(10, 0), jpeg(0, 10), jpeg(10, 0)]) {
      expect(sniffImage(bytes).ok).toBe(false);
    }
  });

  it("rejects a PNG whose first chunk is not IHDR", () => {
    expect(sniffImage(png(10, 10, "IDAT"))).toEqual({ ok: false, reason: "PNG first chunk is not IHDR" });
  });

  it("rejects a JPEG that reaches SOS or EOI without a frame header", () => {
    expect(sniffImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xda, ...be16(4), 0, 0])).ok).toBe(false);
    expect(sniffImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])).ok).toBe(false);
  });

  it("refuses every truncation of a PNG and accepts the full file", () => {
    const full = png(64, 48);
    for (let cut = 0; cut < full.length; cut++) expect(sniffImage(full.subarray(0, cut)).ok).toBe(false);
    expect(sniffImage(full)).toEqual({ ok: true, contentType: "image/png", width: 64, height: 48 });
  });

  it("refuses a PNG whose IEND chunk is damaged", () => {
    const bad = png(64, 48);
    bad[bad.length - 1] = 0x83; // wrong CRC
    expect(sniffImage(bad).ok).toBe(false);
    const noIend = png(64, 48);
    noIend[noIend.length - 6] = 0x58; // "IEND" -> "IEXD"
    expect(sniffImage(noIend).ok).toBe(false);
  });

  it("refuses every truncation of a JPEG and accepts the full file", () => {
    const jpegs = [
      jpeg(64, 48),
      jpeg(64, 48, { sof: 0xc1 }),
      jpeg(64, 48, { sof: 0xc2, pre: [0xff, 0xe0, ...be16(4), 9, 9] }),
    ];
    for (const full of jpegs) {
      for (let cut = 0; cut < full.length; cut++) expect(sniffImage(full.subarray(0, cut)).ok).toBe(false);
      expect(sniffImage(full)).toEqual({ ok: true, contentType: "image/jpeg", width: 64, height: 48 });
    }
  });

  it("refuses a JPEG with a frame header but no scan, or with no EOI after the scan", () => {
    const full = jpeg(64, 48);
    const sos = full.findIndex((v, i) => v === 0xff && full[i + 1] === 0xda);
    expect(sniffImage(full.subarray(0, sos))).toEqual({ ok: false, reason: "JPEG is truncated before a scan (no SOS marker)" });
    expect(sniffImage(full.subarray(0, full.length - 1))).toEqual({ ok: false, reason: "JPEG is truncated (no EOI after the scan)" });
  });

  it("accepts bytes after the EOI (phone cameras append data there), but not an EOI only before the scan", () => {
    const full = jpeg(64, 48);
    expect(sniffImage(Uint8Array.from([...full, 0]))).toEqual({ ok: true, contentType: "image/jpeg", width: 64, height: 48 });
    // an MPF-style second image appended after the first EOI
    expect(sniffImage(Uint8Array.from([...full, ...jpeg(8, 8)])).ok).toBe(true);
    // stuffed FF 00 and a restart marker inside the scan are not an EOI
    const noEoi = Uint8Array.from([...full.subarray(0, full.length - 2), 0xff, 0x00, 0xff, 0xd0, 7]);
    expect(sniffImage(noEoi).ok).toBe(false);
  });

  it("accepts only SOF0, SOF1 and SOF2 and names the unsupported coding process", () => {
    for (const sof of [0xc0, 0xc1, 0xc2]) expect(sniffImage(jpeg(10, 10, { sof })).ok).toBe(true);
    const reasonFor = (sof: number) => {
      const r = sniffImage(jpeg(10, 10, { sof }));
      expect(r.ok).toBe(false);
      return r.ok ? "" : r.reason;
    };
    expect(reasonFor(0xc3)).toContain("lossless");
    expect(reasonFor(0xcb)).toContain("lossless");
    for (const sof of [0xc5, 0xc6, 0xc7]) expect(reasonFor(sof)).toContain("hierarchical");
    for (const sof of [0xc9, 0xca, 0xcd, 0xce, 0xcf]) expect(reasonFor(sof)).toContain("arithmetic");
  });

  it("accepts only 8-bit sample precision", () => {
    expect(sniffImage(jpeg(10, 10, { precision: 8 })).ok).toBe(true);
    for (const precision of [0, 1, 4, 12, 16, 255]) {
      const r = sniffImage(jpeg(10, 10, { precision }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain("precision");
    }
    const r12 = sniffImage(jpeg(10, 10, { sof: 0xc1, precision: 12 }));
    expect(r12.ok).toBe(false);
  });

  it("never throws on short or odd inputs", () => {
    for (let n = 0; n < 40; n++) {
      expect(() => sniffImage(Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 255))).not.toThrow();
      expect(() => sniffImage(new Uint8Array(n).fill(0xff))).not.toThrow();
    }
  });

  it("rejects other formats by magic bytes", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    const cases: Uint8Array[] = [
      enc("GIF89a\u0001\u0000\u0001\u0000"),
      Uint8Array.from([...enc("RIFF"), 0, 0, 0, 0, ...enc("WEBPVP8 ")]),
      enc('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'),
      Uint8Array.from([0, 0, 0, 0x18, ...enc("ftypheic"), 0, 0, 0, 0]),
      Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
      new Uint8Array(0),
    ];
    for (const c of cases) {
      const r = sniffImage(c);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason.length).toBeGreaterThan(0);
    }
  });
});
