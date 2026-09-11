/**
 * Standalone 2D crush-to-grid rasteriser for sprite-forge.
 * Performs area-average downscale, alpha cutoff, shadow selout, and palette snapping.
 */
import { paletteRgb } from "../../render/atlas-census";

export const CX = 64;
export const GROUND = 118;
export const ART_SPACE = CX * 2;
export const SPRITE_PIXEL_GRID = 72;

interface AxisTaps {
  starts: Int32Array;
  counts: Int32Array;
  offs: Int32Array;
  ws: Float64Array;
}

const _tapCache = new Map<string, AxisTaps>();

function axisTaps(src: number, dst: number): AxisTaps {
  const key = `${src}:${dst}`;
  const hit = _tapCache.get(key);
  if (hit) return hit;
  const k = src / dst;
  const starts = new Int32Array(dst);
  const counts = new Int32Array(dst);
  const offs = new Int32Array(dst);
  const ws: number[] = [];
  for (let o = 0; o < dst; o++) {
    const a = o * k;
    const b = (o + 1) * k;
    starts[o] = Math.floor(a);
    offs[o] = ws.length;
    let n = 0;
    for (let i = Math.floor(a); i < Math.ceil(b); i++) {
      ws.push((Math.min(b, i + 1) - Math.max(a, i)) / k);
      n++;
    }
    counts[o] = n;
  }
  const taps: AxisTaps = { starts, counts, offs, ws: Float64Array.from(ws) };
  _tapCache.set(key, taps);
  return taps;
}

let _rowBuf: Float64Array | null = null;
let _pixBuf: Float64Array | null = null;

function snapColorIn(pal: readonly (readonly number[])[], r: number, g: number, b: number): number {
  let bestDist = Infinity;
  let out = 0;
  for (let p = 0; p < pal.length; p++) {
    const dr = (r - pal[p][0]) * 0.3;
    const dg = (g - pal[p][1]) * 0.59;
    const db = (b - pal[p][2]) * 0.11;
    const dist = dr * dr + dg * dg + db * db;
    if (dist < bestDist) {
      bestDist = dist;
      out = p;
    }
  }
  return out;
}

export function crushToGrid(
  src: HTMLCanvasElement,
  grid: number = SPRITE_PIXEL_GRID,
  pal?: readonly (readonly number[])[],
): HTMLCanvasElement {
  const g = grid;
  const small = document.createElement("canvas");
  small.width = g;
  small.height = g;
  const sctx = small.getContext("2d", { willReadFrequently: true });
  if (!sctx) throw new Error("[crush] no 2d context");

  const sw = src.width;
  const sh = src.height;
  const sctx2 = src.getContext("2d");
  if (!sctx2) throw new Error("[crush] source has no 2D context");
  const sd = sctx2.getImageData(0, 0, sw, sh).data;

  const tx = axisTaps(sw, g);
  const ty = axisTaps(sh, g);
  if (!_rowBuf || _rowBuf.length < g * sh * 4) _rowBuf = new Float64Array(g * sh * 4);
  if (!_pixBuf || _pixBuf.length < g * g * 4) _pixBuf = new Float64Array(g * g * 4);
  const row = _rowBuf;
  const pix = _pixBuf;

  // ── horizontal pass: sw×sh → g×sh, RGB weighted by alpha ──
  for (let y = 0; y < sh; y++) {
    const ro = y * sw * 4;
    const to = y * g * 4;
    for (let x = 0; x < g; x++) {
      const st = tx.starts[x];
      const n = tx.counts[x];
      const wo = tx.offs[x];
      let r = 0, gg = 0, b = 0, a = 0;
      for (let t = 0; t < n; t++) {
        const i = ro + (st + t) * 4;
        const al = sd[i + 3] * tx.ws[wo + t];
        r += sd[i] * al;
        gg += sd[i + 1] * al;
        b += sd[i + 2] * al;
        a += al;
      }
      const o = to + x * 4;
      row[o] = r;
      row[o + 1] = gg;
      row[o + 2] = b;
      row[o + 3] = a;
    }
  }

  // ── vertical pass: g×sh → g×g, then un-premultiply ──
  for (let y = 0; y < g; y++) {
    const st = ty.starts[y];
    const n = ty.counts[y];
    const wo = ty.offs[y];
    for (let x = 0; x < g; x++) {
      let r = 0, gg = 0, b = 0, a = 0;
      for (let t = 0; t < n; t++) {
        const i = ((st + t) * g + x) * 4;
        const w = ty.ws[wo + t];
        r += row[i] * w;
        gg += row[i + 1] * w;
        b += row[i + 2] * w;
        a += row[i + 3] * w;
      }
      const o = (y * g + x) * 4;
      pix[o] = a > 0 ? r / a : 0;
      pix[o + 1] = a > 0 ? gg / a : 0;
      pix[o + 2] = a > 0 ? b / a : 0;
      pix[o + 3] = a;
    }
  }

  const im = sctx.createImageData(g, g);
  const d = im.data;
  const basePal = paletteRgb();
  const PAL_RGB = pal?.length ? [...basePal, ...pal] : basePal;

  const keep = new Uint8Array(g * g);
  for (let i = 0; i < g * g; i++) keep[i] = pix[i * 4 + 3] >= 128 ? 1 : 0;

  // ── SELOUT on the shadow-side rim ──
  const shadow = 0.6;
  const ink = PAL_RGB[1] ?? [0, 0, 0];
  const K = (x: number, y: number): number => (x < 0 || y < 0 || x >= g || y >= g ? 0 : keep[y * g + x]);
  for (let y = 0; y < g; y++) {
    for (let x = 0; x < g; x++) {
      const i = (y * g + x) * 4;
      if (!keep[y * g + x]) {
        d[i + 3] = 0;
        continue;
      }
      let r = pix[i];
      let gg = pix[i + 1];
      let b = pix[i + 2];
      if (!(K(x + 1, y) && K(x, y + 1))) {
        r = r * (1 - shadow) + ink[0] * shadow;
        gg = gg * (1 - shadow) + ink[1] * shadow;
        b = b * (1 - shadow) + ink[2] * shadow;
      }
      const best = snapColorIn(PAL_RGB, r, gg, b);
      d[i] = PAL_RGB[best][0];
      d[i + 1] = PAL_RGB[best][1];
      d[i + 2] = PAL_RGB[best][2];
      d[i + 3] = 255;
    }
  }

  sctx.putImageData(im, 0, 0);
  return small;
}
