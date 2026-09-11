/**
 * CELL RESAMPLING — the hop that decides whether imported art survives.
 *
 * The import path used to hand the whole source cell to ONE
 * `ctx.drawImage(...)` and let the browser scale it. At the scales a sheet
 * actually arrives at (a 227px figure onto ~90px of paint buffer, 2.5-3×
 * down), the browser's bilinear filter samples a 2×2 neighbourhood per output
 * pixel and SKIPS most of the source — undersampling, which reads as mush —
 * and mixes RGB across the alpha edge, which reads as a dark fringe. The
 * palette snap downstream then turns that mush into confetti: the census
 * measured the imported jester at 46% isolated pixels against 38.1% for its
 * own painter.
 *
 * This is the same lesson the classic pipelines encode. MUGEN sprites are
 * hand-pixeled at their final resolution on a shared indexed palette; Rivals
 * of Aether sprites are authored at native size and resized only by whole
 * numbers. Art COMMITS to a pixel grid once; every fractional resample after
 * that is damage. Generated sheets arrive without a grid, so this module is
 * where they commit — with the best filter we can give them, not the
 * browser's default.
 *
 * Three strategies, because the right one was not obvious and the harness
 * (`scripts/sandbox.mjs`) can show all of them side by side:
 *
 *   box       Premultiplied separable area average — the same filter the
 *             engine's crush uses (engine/render/sprite.ts documents the edge-
 *             darkening argument). Correct, never invents, but averages an
 *             AI sheet's soft gradients into in-between colours the palette
 *             snap has to guess at.
 *
 *   dominant  Box average UNLESS one quantized colour owns ≥ half the texel's
 *             opaque coverage, in which case that colour wins outright (its
 *             true weighted mean, not the bin centre). The "hybrid/ALG-50"
 *             strategy from the AI-pixel-art-fixing tools: flat regions the
 *             artist intended stay flat, so the snap has nothing to invent.
 *
 *   kcentroid The community standard for AI art downscaling (Astropulse's
 *             pixeldetector): per texel, split the covered block into two
 *             clusters by weighted k-means and take the dominant cluster's
 *             centroid. Where `dominant` needs one colour to hold a majority,
 *             this only needs the block to be SEPARABLE — a noisy red-and-
 *             cream texel picks its red side instead of averaging to mauve.
 *
 *   nearest   Point-sample the texel centre, colour AND alpha. This is what a
 *             pixel-art editor's batch resize does (LibreSprite and Pixelorama
 *             both default their scalers to it for sprite work) — correct for
 *             art that IS on a grid already, and the wrong tool for soft
 *             generated art, where it lands on whichever noise pixel the
 *             centre hits. In the roster as the editor-pipeline arm of the
 *             comparison, not as a candidate.
 *
 * Pure pixels-in-pixels-out, no DOM, no engine imports — a node test and the
 * browser run the identical bytes.
 */

export type ResampleStrategy = "box" | "dominant" | "kcentroid" | "nearest";

/**
 * Structural stand-in for `ImageData`, which node has no global for. A browser
 * `ImageData` satisfies it as-is; node callers hand in `getImageData`'s result
 * and blit the return through `ctx.createImageData` — the one constructor both
 * runtimes share.
 */
export interface RawImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** One colour accumulator per 4-bit-quantized bin. 16 levels per channel is
 *  coarse on purpose: generation noise spans ±8, and a bin split by noise
 *  hands the vote to whichever half is luckier. */
const BIN = (r: number, g: number, b: number): number => ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);

/** A texel's share of opaque coverage one colour must own to win outright. */
const DOMINANT_SHARE = 0.5;

/** k-means passes per texel. The blocks are ≤ ~5×5 source pixels; the
 *  centroids stop moving in 2-3 passes and 4 is a ceiling, not a target. */
const KMEANS_PASSES = 4;

/**
 * Resample `src` to exactly `dw`×`dh`, by strategy.
 *
 * Alpha is ALWAYS the premultiplied box average regardless of strategy — the
 * crush downstream applies a hard alpha cutout, and it is the right place for
 * that decision. Strategies only decide the COLOUR of each texel.
 */
/**
 * Nearest-upscale by a WHOLE factor — exact block replication, no sampling.
 *
 * The other half of `blockReduce`: reduce a gridded cell to its authored
 * texels, replicate each texel `up × up`, and a downstream box filter of the
 * same factor collapses it back byte-identically. Used by the runtime and the
 * forge preview so a committed sheet's "1:1 import" is block copies, never a
 * resample.
 */
export function upscaleExact(src: RawImage, up: number): RawImage {
  if (up === 1) return src;
  const w = src.width * up;
  const h = src.height * up;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = (y / up) | 0;
    for (let x = 0; x < w; x++) {
      const s = (sy * src.width + ((x / up) | 0)) * 4;
      const d = (y * w + x) * 4;
      data[d] = src.data[s];
      data[d + 1] = src.data[s + 1];
      data[d + 2] = src.data[s + 2];
      data[d + 3] = src.data[s + 3];
    }
  }
  return { width: w, height: h, data };
}

export function resampleCell(src: RawImage, dw: number, dh: number, strategy: ResampleStrategy = "kcentroid"): RawImage {
  const { width: sw, height: sh, data } = src;
  const out: RawImage = { width: dw, height: dh, data: new Uint8ClampedArray(dw * dh * 4) };
  const o = out.data;
  const kx = sw / dw;
  const ky = sh / dh;

  // Scratch, reallocated per call — this runs once per cell per atlas build,
  // not per frame, so the allocation argument that shapes the engine's crush
  // scratch does not apply here.
  const bins = new Map<number, { w: number; r: number; g: number; b: number }>();
  const px: number[] = []; // flat [w, r, g, b] runs for the k-means strategy

  // Point sampling shares nothing with the coverage loop — handle it and leave.
  if (strategy === "nearest") {
    for (let oy = 0; oy < dh; oy++) {
      const sy = Math.min(sh - 1, Math.floor((oy + 0.5) * ky));
      for (let ox = 0; ox < dw; ox++) {
        const sx = Math.min(sw - 1, Math.floor((ox + 0.5) * kx));
        const i = (sy * sw + sx) * 4;
        const j = (oy * dw + ox) * 4;
        o[j] = data[i];
        o[j + 1] = data[i + 1];
        o[j + 2] = data[i + 2];
        o[j + 3] = data[i + 3];
      }
    }
    return out;
  }

  for (let oy = 0; oy < dh; oy++) {
    const ay = oy * ky;
    const by = ay + ky;
    for (let ox = 0; ox < dw; ox++) {
      const ax = ox * kx;
      const bx = ax + kx;

      // ── premultiplied box pass, plus per-strategy bookkeeping ──
      let sumW = 0; // total footprint weight
      let sumA = 0; // alpha-weighted weight
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      bins.clear();
      px.length = 0;

      for (let y = Math.floor(ay); y < Math.ceil(by); y++) {
        const wy = Math.min(by, y + 1) - Math.max(ay, y);
        for (let x = Math.floor(ax); x < Math.ceil(bx); x++) {
          const wx = Math.min(bx, x + 1) - Math.max(ax, x);
          const w = wx * wy;
          const i = (y * sw + x) * 4;
          const a = data[i + 3] / 255;
          const aw = a * w;
          sumW += w;
          sumA += aw;
          if (aw <= 0) continue;
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          sumR += r * aw;
          sumG += g * aw;
          sumB += b * aw;
          if (strategy === "dominant") {
            const key = BIN(r, g, b);
            const bin = bins.get(key);
            if (bin) {
              bin.w += aw;
              bin.r += r * aw;
              bin.g += g * aw;
              bin.b += b * aw;
            } else bins.set(key, { w: aw, r: r * aw, g: g * aw, b: b * aw });
          } else if (strategy === "kcentroid") {
            px.push(aw, r, g, b);
          }
        }
      }

      const j = (oy * dw + ox) * 4;
      o[j + 3] = Math.round((sumA / (sumW || 1)) * 255);
      if (sumA <= 0) continue; // fully transparent texel — colour is moot

      // box colour: the fallback every strategy can land on
      let r = sumR / sumA;
      let g = sumG / sumA;
      let b = sumB / sumA;

      if (strategy === "dominant") {
        let best: { w: number; r: number; g: number; b: number } | null = null;
        for (const bin of bins.values()) if (!best || bin.w > best.w) best = bin;
        if (best && best.w >= DOMINANT_SHARE * sumA) {
          r = best.r / best.w;
          g = best.g / best.w;
          b = best.b / best.w;
        }
      } else if (strategy === "kcentroid") {
        const c = kCentroid(px);
        if (c) {
          r = c[0];
          g = c[1];
          b = c[2];
        }
      }
      o[j] = Math.round(r);
      o[j + 1] = Math.round(g);
      o[j + 2] = Math.round(b);
    }
  }
  return out;
}

/**
 * Dominant centroid of a 2-means split over one texel's covered pixels.
 *
 * Seeds are the two pixels farthest from the block mean in opposite luma
 * directions — the cheap version of farthest-pair init, and enough for blocks
 * this small. Returns null when the block cannot split (one colour, or one
 * pixel), which tells the caller the box average was already right.
 */
function kCentroid(px: readonly number[]): [number, number, number] | null {
  const n = px.length / 4;
  if (n < 2) return null;

  // seed with the min- and max-luma pixels; identical seeds = nothing to split
  let lo = 0;
  let hi = 0;
  let loL = Infinity;
  let hiL = -Infinity;
  for (let i = 0; i < n; i++) {
    const l = 0.3 * px[i * 4 + 1] + 0.59 * px[i * 4 + 2] + 0.11 * px[i * 4 + 3];
    if (l < loL) {
      loL = l;
      lo = i;
    }
    if (l > hiL) {
      hiL = l;
      hi = i;
    }
  }
  if (hiL - loL < 1) return null;

  let c0 = [px[lo * 4 + 1], px[lo * 4 + 2], px[lo * 4 + 3]];
  let c1 = [px[hi * 4 + 1], px[hi * 4 + 2], px[hi * 4 + 3]];
  let w0 = 0;
  let w1 = 0;
  for (let pass = 0; pass < KMEANS_PASSES; pass++) {
    let a0 = 0, a1 = 0, r0 = 0, g0 = 0, b0 = 0, r1 = 0, g1 = 0, b1 = 0;
    for (let i = 0; i < n; i++) {
      const w = px[i * 4];
      const r = px[i * 4 + 1];
      const g = px[i * 4 + 2];
      const b = px[i * 4 + 3];
      const d0 = (r - c0[0]) ** 2 + (g - c0[1]) ** 2 + (b - c0[2]) ** 2;
      const d1 = (r - c1[0]) ** 2 + (g - c1[1]) ** 2 + (b - c1[2]) ** 2;
      if (d0 <= d1) {
        a0 += w;
        r0 += r * w;
        g0 += g * w;
        b0 += b * w;
      } else {
        a1 += w;
        r1 += r * w;
        g1 += g * w;
        b1 += b * w;
      }
    }
    if (a0 <= 0 || a1 <= 0) return null; // degenerate split — box was right
    c0 = [r0 / a0, g0 / a0, b0 / a0];
    c1 = [r1 / a1, g1 / a1, b1 / a1];
    w0 = a0;
    w1 = a1;
  }
  const c = w0 >= w1 ? c0 : c1;
  return [c[0], c[1], c[2]];
}
