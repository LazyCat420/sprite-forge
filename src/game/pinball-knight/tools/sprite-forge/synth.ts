/**
 * AUTHORING AT FINAL RESOLUTION — the alternative to voting.
 *
 * ── WHAT IS WRONG WITH THE VOTE ─────────────────────────────────────────────
 *
 * `resampleCell`'s k-centroid asks one question per output texel: of the source
 * pixels under this texel, which colour dominates? That is a good answer to a
 * question about ONE TEXEL and no answer at all to a question about a REGION.
 * A smooth gradient across a pauldron gives every texel a slightly different
 * winner, so the pauldron arrives as a mosaic of 2-4 texel patches — the
 * "melting" a Ragnarok Online sprite does not have, because RO's pauldron is
 * one flat region with an outline round it.
 *
 * `minRegion` attacks the mosaic AFTER it exists, by absorbing the patches. It
 * measurably helps (isolated 10.0% → 6.3% on the knight's E facing) and it is
 * still repair work: the reduce made a decision per texel and the flattener
 * argues with it.
 *
 * ── WHAT THIS DOES INSTEAD ──────────────────────────────────────────────────
 *
 * Decide the REGIONS FIRST, at a scale a texel can hold, and then colour them.
 *
 *   1. SLIC superpixels over the SOURCE cell, spaced so one superpixel is about
 *      `regionTexels` output texels of area. This is a k-means in (L,a,b,x,y):
 *      colour pulls a region toward one material, position keeps it compact, so
 *      the boundaries land on real edges instead of on a lattice.
 *   2. Every superpixel takes ONE colour — its own weighted mean. Flatness is
 *      now a property of the construction, not a metric to chase.
 *   3. Rasterise to the texel grid by majority LABEL, not by majority colour.
 *      A texel that straddles two regions joins the one it mostly belongs to;
 *      it cannot invent a blend of the two, which is what the box filter does.
 *   4. Author the outline: every texel with a transparent orthogonal neighbour
 *      becomes ink. RO and Golden Sun both do this deliberately and it is the
 *      other half of the read — the flat region and the hard 1-texel edge round
 *      it are one design, not two.
 *
 * ── THE KNOBS, SWEPT — AND WHAT THE NUMBERS COULD NOT SEE ───────────────────
 *
 * `regionTexels` × `compactness`, 5 × 3, through the real commit and the real
 * crush (the sweep run of 2026-08-04; re-run it from `bench.test.ts`'s arms):
 *
 *     every one of the fifteen cells:  isolated 2.3-2.8%,  mosaic 17.5-21.4%
 *
 * **The whole surface is flat on every metric this repo has.** A tuning knob
 * that measures identically at both ends is not therefore a knob that does
 * nothing — and the pictures say it plainly:
 *
 *   · `compactness` 1.5 EATS THE EYE. Round regions win over colour, so the
 *     pupil is absorbed into the face it sits in. The eyebrow goes with it.
 *   · `regionTexels` ≥ 12 softens the mouth and chin into the cheek.
 *   · 0.2-0.55 with 3-7 texels all keep a crisp pupil and its glint.
 *
 * ⚠️ THE BEST-SCORING CELL IS THE WORST-LOOKING ONE. `regionTexels` 12 /
 * `compactness` 1.5 scored the lowest isolated% (2.3) AND the lowest mosaic%
 * (17.5) of the fifteen, and its face is a smear. That is the same trap
 * `snap-metric.test.ts` recorded when its ban-`stone` arm swept every family
 * metric and came back speckled blue — noise metrics reward a sprite for
 * having fewer things in it, and an eye is a thing. Defaults are set from the
 * PICTURES; the numbers only prove the knobs are not buying noise reduction.
 */
import { oklab, type Oklab } from "./colour";
import { INK_RGB } from "./palette-derive";
import type { RawImage } from "./resample";

const OPAQUE_CUTOFF = 127;

export interface SynthOptions {
  /** Target area of one superpixel, in OUTPUT TEXELS. */
  regionTexels?: number;
  /**
   * How much position counts against colour in the superpixel k-means.
   *
   * In OKLab-and-normalised-position units, so it is not the `m` from the SLIC
   * paper (which is in CIELAB and pixel units). Higher = rounder, blockier
   * regions; lower = regions that follow colour across the whole figure.
   */
  compactness?: number;
  /** Author a 1-texel ink border on the silhouette. */
  outline?: boolean;
  /** Lloyd iterations. 10 is where the boundaries stop moving on this art. */
  iterations?: number;
}

/** Set from the sweep's PICTURES — 12 and up softens the mouth into the cheek. */
export const DEFAULT_REGION_TEXELS = 7;
/** Set from the sweep's PICTURES — 1.5 absorbs the pupil into the face. */
export const DEFAULT_COMPACTNESS = 0.55;
export const DEFAULT_SYNTH_ITERS = 10;

interface Centre {
  lab: Oklab;
  /** Position in NORMALISED cell coordinates (0..1 on the longer axis). */
  x: number;
  y: number;
}

/**
 * One cell of source art → one cell of authored texels.
 *
 * Returns an image `tw × th` whose opaque texels each carry a REGION's colour,
 * not a per-texel average. Alpha is already binarised: a texel is opaque when
 * the source pixels under it are mostly opaque, so the silhouette is a hard
 * edge before anything downstream looks at it.
 */
export function synthCell(src: RawImage, tw: number, th: number, opts: SynthOptions = {}): RawImage {
  const regionTexels = Math.max(1, opts.regionTexels ?? DEFAULT_REGION_TEXELS);
  const compact = opts.compactness ?? DEFAULT_COMPACTNESS;
  const iters = opts.iterations ?? DEFAULT_SYNTH_ITERS;
  const outline = opts.outline ?? true;
  const { width: sw, height: sh, data } = src;

  // ── The pixels that are allowed to vote ──────────────────────────────────
  const opaque = new Uint8Array(sw * sh);
  const lab: Oklab[] = new Array(sw * sh);
  let live = 0;
  for (let p = 0; p < sw * sh; p++) {
    if (data[p * 4 + 3] <= OPAQUE_CUTOFF) continue;
    opaque[p] = 1;
    lab[p] = oklab(data[p * 4], data[p * 4 + 1], data[p * 4 + 2]);
    live++;
  }
  const out: RawImage = { width: tw, height: th, data: new Uint8ClampedArray(tw * th * 4) };
  if (!live) return out;

  // ── Superpixel spacing ───────────────────────────────────────────────────
  //
  // One superpixel should cover `regionTexels` output texels, and one output
  // texel covers `sw/tw × sh/th` source pixels. Spacing is the square root of
  // that area, floored at 2 so a tiny cell still gets more than one region.
  const perTexel = (sw / tw) * (sh / th);
  const spacing = Math.max(2, Math.sqrt(regionTexels * perTexel));
  const gx = Math.max(1, Math.round(sw / spacing));
  const gy = Math.max(1, Math.round(sh / spacing));

  // Position is normalised by the cell's LONGER axis, so the compactness term
  // means the same thing on a tall idle and a wide sword swing.
  const norm = 1 / Math.max(sw, sh);
  const centres: Centre[] = [];
  for (let j = 0; j < gy; j++) {
    for (let i = 0; i < gx; i++) {
      const cx = Math.min(sw - 1, Math.floor(((i + 0.5) * sw) / gx));
      const cy = Math.min(sh - 1, Math.floor(((j + 0.5) * sh) / gy));
      // Seed on the nearest OPAQUE pixel — a seed in the transparent surround
      // owns nothing and its slot is wasted, and on a thin limb that is most of
      // the grid row.
      let at = cy * sw + cx;
      if (!opaque[at]) {
        let bd = Infinity;
        for (let y = 0; y < sh; y++) {
          for (let x = 0; x < sw; x++) {
            const p = y * sw + x;
            if (!opaque[p]) continue;
            const d = (x - cx) * (x - cx) + (y - cy) * (y - cy);
            if (d < bd) { bd = d; at = p; }
          }
        }
        if (bd === Infinity) continue;
      }
      centres.push({ lab: lab[at], x: (at % sw) * norm, y: ((at / sw) | 0) * norm });
    }
  }
  if (!centres.length) return out;

  // ── Lloyd, restricted to a 2×spacing window round each centre ────────────
  //
  // The window is what makes this SLIC and not a global k-means: a pixel can
  // only join a region whose centre is nearby, so a region cannot teleport
  // across the figure to collect every pixel of one grey. Cost is O(pixels)
  // per iteration rather than O(pixels × regions).
  const label = new Int32Array(sw * sh).fill(-1);
  const best = new Float64Array(sw * sh).fill(Infinity);
  const win = Math.ceil(spacing);
  for (let it = 0; it < iters; it++) {
    best.fill(Infinity);
    label.fill(-1);
    for (let c = 0; c < centres.length; c++) {
      const cx = Math.round(centres[c].x / norm);
      const cy = Math.round(centres[c].y / norm);
      const x0 = Math.max(0, cx - win), x1 = Math.min(sw - 1, cx + win);
      const y0 = Math.max(0, cy - win), y1 = Math.min(sh - 1, cy + win);
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const p = y * sw + x;
          if (!opaque[p]) continue;
          const dL = lab[p].L - centres[c].lab.L;
          const da = lab[p].a - centres[c].lab.a;
          const db = lab[p].b - centres[c].lab.b;
          const dx = x * norm - centres[c].x;
          const dy = y * norm - centres[c].y;
          const d = dL * dL + da * da + db * db + compact * compact * (dx * dx + dy * dy);
          if (d < best[p]) { best[p] = d; label[p] = c; }
        }
      }
    }
    // A pixel no window reached keeps whatever it had; on the last pass those
    // are picked up by the fallback below rather than left unlabelled.
    const sum = centres.map(() => ({ r: 0, g: 0, b: 0, x: 0, y: 0, n: 0 }));
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        const p = y * sw + x;
        const c = label[p];
        if (c < 0) continue;
        const a = sum[c];
        a.r += data[p * 4]; a.g += data[p * 4 + 1]; a.b += data[p * 4 + 2];
        a.x += x * norm; a.y += y * norm; a.n++;
      }
    }
    for (let c = 0; c < centres.length; c++) {
      const a = sum[c];
      if (!a.n) continue;
      centres[c] = { lab: oklab(a.r / a.n, a.g / a.n, a.b / a.n), x: a.x / a.n, y: a.y / a.n };
    }
  }

  // ── One colour per region ────────────────────────────────────────────────
  const acc = centres.map(() => ({ r: 0, g: 0, b: 0, n: 0 }));
  for (let p = 0; p < sw * sh; p++) {
    const c = label[p];
    if (c < 0) continue;
    acc[c].r += data[p * 4]; acc[c].g += data[p * 4 + 1]; acc[c].b += data[p * 4 + 2]; acc[c].n++;
  }
  const regionRgb = acc.map((a) => (a.n ? [a.r / a.n, a.g / a.n, a.b / a.n] : [0, 0, 0]));

  // ── Rasterise by majority LABEL ──────────────────────────────────────────
  //
  // ⚠️ LABEL, NOT COLOUR. Averaging the colours under a texel is the box filter
  // this exists to replace — it invents a value in neither region and hands the
  // snap an ambiguous vote. Counting labels asks "which region does this texel
  // belong to", which has an answer.
  const votes = new Map<number, number>();
  for (let ty = 0; ty < th; ty++) {
    const sy0 = Math.floor((ty * sh) / th);
    const sy1 = Math.max(sy0 + 1, Math.floor(((ty + 1) * sh) / th));
    for (let tx = 0; tx < tw; tx++) {
      const sx0 = Math.floor((tx * sw) / tw);
      const sx1 = Math.max(sx0 + 1, Math.floor(((tx + 1) * sw) / tw));
      votes.clear();
      let op = 0, tot = 0;
      for (let y = sy0; y < sy1 && y < sh; y++) {
        for (let x = sx0; x < sx1 && x < sw; x++) {
          const p = y * sw + x;
          tot++;
          if (!opaque[p]) continue;
          op++;
          const c = label[p];
          if (c < 0) continue;
          votes.set(c, (votes.get(c) ?? 0) + 1);
        }
      }
      const o = (ty * tw + tx) * 4;
      // Half coverage is the same cutout rule the runtime crush applies, so the
      // silhouette the artist reviews is the silhouette that ships.
      if (!tot || op * 2 < tot || !votes.size) { out.data[o + 3] = 0; continue; }
      let win2 = -1, wn = -1;
      for (const [c, n] of votes) if (n > wn) { wn = n; win2 = c; }
      const rgb = regionRgb[win2];
      out.data[o] = Math.round(rgb[0]);
      out.data[o + 1] = Math.round(rgb[1]);
      out.data[o + 2] = Math.round(rgb[2]);
      out.data[o + 3] = 255;
    }
  }

  // ── The authored outline ─────────────────────────────────────────────────
  //
  // Read from a snapshot of the alpha, so an inked texel does not make its
  // neighbour an edge texel too and the outline stays ONE texel wide. That is
  // the difference between an outline and a creature losing two texels of
  // silhouette on every limb.
  if (outline) {
    const alpha = new Uint8Array(tw * th);
    for (let p = 0; p < tw * th; p++) alpha[p] = out.data[p * 4 + 3] ? 1 : 0;
    for (let y = 0; y < th; y++) {
      for (let x = 0; x < tw; x++) {
        const p = y * tw + x;
        if (!alpha[p]) continue;
        const edge =
          x === 0 || y === 0 || x === tw - 1 || y === th - 1 ||
          !alpha[p - 1] || !alpha[p + 1] || !alpha[p - tw] || !alpha[p + tw];
        if (!edge) continue;
        out.data[p * 4] = INK_RGB[0];
        out.data[p * 4 + 1] = INK_RGB[1];
        out.data[p * 4 + 2] = INK_RGB[2];
      }
    }
  }
  return out;
}
