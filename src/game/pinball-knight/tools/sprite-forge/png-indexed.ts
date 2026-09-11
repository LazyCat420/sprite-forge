/**
 * INDEXED PNG, because a 24-colour sprite should not ship as 32-bit RGBA.
 *
 * Every artifact this pipeline produces for review — contact sheets, A/B
 * strips, the candidate bench — is palette-locked art inlined into an HTML page
 * as base64, and base64 costs 4 bytes for every 3. The bench's 238 strips came
 * to 2.2 MB through node-canvas, which writes colour-type 6 (RGBA) and ignores
 * the `palette` option in `toBuffer`. The same pixels as colour-type 3 with a
 * PLTE/tRNS pair are roughly a quarter of that, losslessly, and the difference
 * decides whether a voting page loads or not.
 *
 * Deliberately minimal: one IDAT, filter type 0 on every row, 8 bits per index.
 * A smarter encoder would try the five PNG filters per row and pick the best —
 * on flat pixel art with long identical runs, filter 0 already gives deflate
 * exactly the runs it wants, and the adaptive version measured within 2%.
 */
import { deflateSync } from "node:zlib";

/** PNG's CRC-32, table built once. */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * RGBA pixels → an indexed PNG, or `null` when the image holds more than 256
 * distinct RGBA values.
 *
 * Returning null rather than quantising is the whole contract: this is used on
 * art whose exact colours are the thing under review, and an encoder that
 * silently dropped one would be changing the evidence. The caller falls back to
 * whatever it was doing before.
 */
export function encodeIndexedPng(width: number, height: number, rgba: Uint8ClampedArray): Buffer | null {
  const index = new Map<number, number>();
  const pixels = new Uint8Array(width * height);
  for (let p = 0; p < width * height; p++) {
    const i = p * 4;
    // Transparent pixels are collapsed onto ONE key regardless of their RGB.
    // A crushed sprite's clear surround carries whatever colour happened to be
    // under it, so without this a two-colour sprite arrives with hundreds of
    // invisible entries and blows the 256 limit for no visible reason.
    const key = rgba[i + 3] === 0 ? -1 : (rgba[i] << 24) | (rgba[i + 1] << 16) | (rgba[i + 2] << 8) | rgba[i + 3];
    let at = index.get(key);
    if (at === undefined) {
      if (index.size >= 256) return null;
      at = index.size;
      index.set(key, at);
    }
    pixels[p] = at;
  }

  const n = index.size;
  const plte = new Uint8Array(n * 3);
  const trns = new Uint8Array(n).fill(255);
  for (const [key, at] of index) {
    if (key === -1) { trns[at] = 0; continue; }
    plte[at * 3] = (key >>> 24) & 255;
    plte[at * 3 + 1] = (key >>> 16) & 255;
    plte[at * 3 + 2] = (key >>> 8) & 255;
    trns[at] = key & 255;
  }

  // Raw scanlines: one filter byte (0 = None) then the row's indices.
  const raw = new Uint8Array(height * (width + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0;
    raw.set(pixels.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  }

  const ihdr = new Uint8Array(13);
  const hv = new DataView(ihdr.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 3; // colour type: indexed
  // 10-12: compression 0, filter 0, interlace 0 — already zero.

  // tRNS is omitted entirely when nothing is transparent; a fully opaque strip
  // does not need the chunk and some tools flag an all-255 tRNS as redundant.
  const parts = [
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("PLTE", plte),
    ...(trns.some((a) => a !== 255) ? [chunk("tRNS", trns)] : []),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array(0)),
  ];
  return Buffer.concat(parts.map((p) => Buffer.from(p)));
}
