/**
 * ATLAS NOISE CENSUS — the numbers that decide whether a sprite is "clean".
 *
 * ⚠️ EVERY METRIC HERE IS COMPUTED ON THE ATLAS CELL, NEVER ON THE 128-UNIT CEL.
 * The authored cel is a sketch; the product is the SPRITE_PIXEL_GRID texel grid
 * the GPU actually samples. Censusing the cel undercounts by ~3x because ellipse
 * antialiasing spreads every boundary across colours no palette entry owns, and
 * it once shipped a brown giraffe past thirteen green tests.
 *
 * WHY THIS IS A PRODUCTION MODULE AND NOT A TEST HELPER: two consumers that
 * cannot share a `.test.ts`. Vitest imports it directly, and the esbuild sheet
 * harnesses under `scripts/` (`bundle()` resolves from the repo root, see
 * scripts/lib/card-harness.mjs) import it by the same relative path. It has no
 * DOM, no canvas and no engine imports beyond the palette source, so it costs
 * the client bundle nothing it would not already pay.
 *
 * DEFINITIONS ARE LOAD-BEARING. A baseline is only reproducible if the metric is
 * pinned exactly, so each one states its edge cases:
 *
 *   opaque      alpha > 127. Not "alpha > 0" — 127 is the GPU's `alphaTest 0.5`
 *               cutoff, so anything below it is not on screen and counting it
 *               measures pixels no player sees.
 *   unmatched   opaque, but not an exact palette RGB. MUST be zero on a crushed
 *               cell: the crush snaps every kept texel. A nonzero count means the
 *               filter changed under you, and it silently deflates every metric
 *               below it — so assert it rather than reporting it.
 *   entries     distinct palette indices over opaque texels.
 *   isolated%   share of opaque texels with NO orthogonal neighbour that is both
 *               opaque and the same index. Out-of-bounds counts as not-opaque, so
 *               a figure touching the cell edge is not penalised for the edge.
 *               This is the literal orphan-pixel count — the thing the eye reads
 *               as "noise".
 *   runLen      mean length of maximal horizontal runs of one index over opaque
 *               texels. Transparency breaks a run. Averaged over RUNS, not over
 *               pixels — a pixel-weighted mean is dominated by the one long run
 *               across the belly and stops responding to the confetti entirely.
 *
 * Pixel art is runs; noise is runs of 1. `runLen` is the best single number.
 */

import { enginePalette } from "../engine/palette-source";

/** Sentinel indices in an index map. */
export const IDX_CLEAR = -1;
/** Opaque, but not an exact palette colour — see `unmatched`. */
export const IDX_UNMATCHED = -2;

/** The GPU's alphaTest 0.5 cutoff, in bytes. */
export const OPAQUE_CUTOFF = 127;

export interface CellStats {
  /** Texels above the alpha cutoff. */
  opaque: number;
  /** Opaque texels whose RGB is not an exact palette entry. Must be 0. */
  unmatched: number;
  /** Distinct palette indices present. */
  entries: number;
  /** Share of opaque texels with no orthogonal same-index opaque neighbour. */
  isolatedPct: number;
  /** Mean maximal horizontal same-index run. */
  runLen: number;
  /** Opaque texel count per palette index. */
  counts: Uint32Array;
}

/** Palette as [r,g,b] byte triples, from whatever palette is currently installed. */
export function paletteRgb(): number[][] {
  return enginePalette.hex().map((h) => [(h >> 16) & 255, (h >> 8) & 255, h & 255]);
}

/**
 * Reverse lookup from packed 0xRRGGBB to palette index.
 *
 * Rebuilt per call rather than memoised: `installPalette` and the tinted-sheet
 * bake both mutate the palette in place, and a stale map here would report
 * `unmatched` on colours that are perfectly on-palette — a failure that reads as
 * a filter bug and is not one.
 */
function exactMap(pal: number[][]): Map<number, number> {
  const m = new Map<number, number>();
  for (let i = 0; i < pal.length; i++) {
    m.set((pal[i][0] << 16) | (pal[i][1] << 8) | pal[i][2], i);
  }
  return m;
}

/**
 * Per-texel palette index for one square cell.
 *
 * `IDX_CLEAR` below the alpha cutoff, `IDX_UNMATCHED` for an opaque texel that is
 * not an exact palette colour. Every other metric is derived from this, so a cell
 * is walked once and measured many times.
 */
export function indexMap(data: Uint8ClampedArray, g: number, pal: number[][] = paletteRgb()): Int16Array {
  const exact = exactMap(pal);
  const out = new Int16Array(g * g);
  for (let p = 0; p < g * g; p++) {
    const i = p * 4;
    if (data[i + 3] <= OPAQUE_CUTOFF) { out[p] = IDX_CLEAR; continue; }
    const hit = exact.get((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
    out[p] = hit === undefined ? IDX_UNMATCHED : hit;
  }
  return out;
}

/** The three metrics plus the per-index histogram, from a prepared index map. */
export function censusIndexMap(idx: Int16Array, g: number, paletteSize: number): CellStats {
  const counts = new Uint32Array(paletteSize);
  let opaque = 0;
  let unmatched = 0;
  let isolated = 0;
  let runs = 0;

  for (let y = 0; y < g; y++) {
    // A run is broken by transparency, by a different index, and by the row end.
    let prev = IDX_CLEAR;
    for (let x = 0; x < g; x++) {
      const v = idx[y * g + x];
      if (v === IDX_CLEAR) { prev = IDX_CLEAR; continue; }
      opaque++;
      if (v === IDX_UNMATCHED) unmatched++;
      else counts[v]++;
      if (v !== prev) runs++;
      prev = v;

      // Orthogonal neighbours only. Diagonals are deliberately excluded: a
      // diagonal-only match is exactly the checkerboard a dither leaves behind,
      // and counting it as "connected" would score dithered confetti as clean.
      const up = y > 0 ? idx[(y - 1) * g + x] : IDX_CLEAR;
      const dn = y < g - 1 ? idx[(y + 1) * g + x] : IDX_CLEAR;
      const lf = x > 0 ? idx[y * g + x - 1] : IDX_CLEAR;
      const rt = x < g - 1 ? idx[y * g + x + 1] : IDX_CLEAR;
      if (up !== v && dn !== v && lf !== v && rt !== v) isolated++;
    }
  }

  let entries = 0;
  for (let i = 0; i < counts.length; i++) if (counts[i]) entries++;

  return {
    opaque,
    unmatched,
    entries,
    isolatedPct: opaque ? (isolated / opaque) * 100 : 0,
    runLen: runs ? opaque / runs : 0,
    counts,
  };
}

/** Census one crushed atlas cell. `data` is RGBA, `g x g`. */
export function censusCell(data: Uint8ClampedArray, g: number, pal: number[][] = paletteRgb()): CellStats {
  return censusIndexMap(indexMap(data, g, pal), g, pal.length);
}

/**
 * Merge per-frame stats into one row for a monster.
 *
 * `entries` is the union across frames, not the mean — a colour that appears in
 * one frame of a walk cycle is a colour the sprite has, and averaging it away is
 * how a budget gets reported as met while a frame busts it. `isolatedPct` and
 * `runLen` are weighted by opaque texels so a mostly-empty frame cannot swing the
 * result.
 */
export function mergeStats(all: readonly CellStats[], paletteSize: number): CellStats {
  const counts = new Uint32Array(paletteSize);
  let opaque = 0;
  let unmatched = 0;
  let isolatedTexels = 0;
  let runs = 0;
  for (const s of all) {
    opaque += s.opaque;
    unmatched += s.unmatched;
    isolatedTexels += (s.isolatedPct / 100) * s.opaque;
    if (s.runLen > 0) runs += s.opaque / s.runLen;
    for (let i = 0; i < counts.length; i++) counts[i] += s.counts[i];
  }
  let entries = 0;
  for (let i = 0; i < counts.length; i++) if (counts[i]) entries++;
  return {
    opaque,
    unmatched,
    entries,
    isolatedPct: opaque ? (isolatedTexels / opaque) * 100 : 0,
    runLen: runs ? opaque / runs : 0,
    counts,
  };
}

/**
 * The colours the PAINTER ASKED FOR, measured off the pre-crush buffer.
 *
 * ⚠️ THIS IS THE NUMBER THE WHOLE FIDELITY ARGUMENT TURNS ON. "The rotortail
 * declares 18 indices and its atlas contains 29" was a hand-count of source
 * literals — unreproducible, and wrong the moment a ramp is edited. Measured
 * instead, `entries(atlas) \ declared(paint)` is the count of colours the
 * pipeline INVENTED after the artist finished, and it is the metric that
 * adjudicates every filter change: a sharpen or a downscale that scores well on
 * `isolated%` by making the sprite duller has not fixed anything.
 *
 * Painters fill via `paletteCss(i)`, so an interior texel of any solid shape is
 * an exact palette RGB at full alpha. `minAlpha` is deliberately near-opaque
 * (250, not 128): an antialiased boundary can land on an exact palette colour by
 * coincidence, and counting those would credit the painter with colours it never
 * requested. `minCount` drops single stray texels for the same reason.
 */
export function declaredSet(
  data: Uint8ClampedArray,
  pal: number[][] = paletteRgb(),
  minAlpha = 250,
  minCount = 4,
): Set<number> {
  const exact = exactMap(pal);
  const counts = new Uint32Array(pal.length);
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < minAlpha) continue;
    const hit = exact.get((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
    if (hit !== undefined) counts[hit]++;
  }
  const out = new Set<number>();
  for (let i = 0; i < counts.length; i++) if (counts[i] >= minCount) out.add(i);
  return out;
}

/** Palette indices present in the atlas that the painter never asked for. */
export function invented(stats: CellStats, declared: ReadonlySet<number>): number[] {
  const out: number[] = [];
  for (let i = 0; i < stats.counts.length; i++) {
    if (stats.counts[i] > 0 && !declared.has(i)) out.push(i);
  }
  return out;
}

export interface NoiseRow {
  key: string;
  entries: number;
  isolatedPct: number;
  runLen: number;
  invented?: number;
  opaque?: number;
}

/**
 * Fixed-width table.
 *
 * Used as an assertion MESSAGE, never printed by a passing test: the whole point
 * of a roster census is to see which monster drifted RELATIVE to its neighbours,
 * and that is unreadable if the failing expectation aborts at the first offender.
 * Collect every row, assert once, pass this as the message.
 */
export function formatNoise(rows: readonly NoiseRow[]): string {
  const w = Math.max(7, ...rows.map((r) => r.key.length));
  const head = `${"monster".padEnd(w)}  entries  isolated%  runLen  invented`;
  const body = rows.map(
    (r) =>
      `${r.key.padEnd(w)}  ${String(r.entries).padStart(7)}  ${r.isolatedPct.toFixed(1).padStart(9)}` +
      `  ${r.runLen.toFixed(2).padStart(6)}  ${(r.invented === undefined ? "-" : String(r.invented)).padStart(8)}`,
  );
  return [head, "-".repeat(head.length), ...body].join("\n");
}
