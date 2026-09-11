/**
 * PER-SPRITE PALETTES — the second of the two levers named as the ceiling.
 *
 * Everything imported so far snaps to 20 of the game's 32 shared Cold-Crypt
 * entries. That is not how the sprites this art is measured against are made:
 * a Ragnarok Online or Golden Sun figure carries ITS OWN palette, authored for
 * that creature, and nothing in it has to be spendable on a dungeon wall.
 *
 * Measured cost of the shared palette (`the-knight-is-grey-because-of-the-
 * palette-snap`): the reduce RAISES the knight's saturation to 0.44 and the
 * snap then spends it back down to 0.318 against a source of 0.399. The snap
 * cannot invent a colour the palette does not hold, and the knight's greys are
 * competing with the dungeon's greys for the same four slots.
 *
 * So derive the palette FROM THE CREATURE. Weighted k-means in OKLab over the
 * texels the commit is about to snap — not over the source pixels, because the
 * thing being coloured is the reduced figure and a 3-pixel highlight that the
 * reduce is going to average away should not win a palette slot.
 *
 * ── WHAT IS DELIBERATELY *NOT* DERIVED ──────────────────────────────────────
 *
 * **Ink.** Entry 0 is pinned to the game's own outline colour. Two reasons, and
 * neither is aesthetic:
 *
 *   · the runtime's `selout` pass blends the shadow-side rim toward the ENGINE
 *     palette's entry 1 (`sprite.ts`), so a sheet whose own ink sat somewhere
 *     else would get a second, different outline colour painted over the one it
 *     authored — two inks on one silhouette.
 *   · every painted actor in the roster outlines in this colour. A creature
 *     that outlines in its own near-black reads as belonging to a different
 *     game standing next to one that does not.
 *
 * **The count.** `n` is the atlas lock, unchanged. Per-sprite palettes are not
 * a request for more colours — they are the same 20 slots, spent on ONE
 * creature instead of shared with the environment.
 */
import { oklab, oklabDist, type Oklab } from "./colour";
import type { RawImage } from "./resample";

/** The outline colour every sheet keeps, derived or not. Mirrors `PALETTE_HEX[1]`. */
export const INK_RGB: readonly number[] = [0x17, 0x1a, 0x22];

/** Alpha at or below which a texel does not vote. Mirrors `commit.ts`. */
const OPAQUE_CUTOFF = 127;

/**
 * Quantise the colour cube this coarsely when building the histogram k-means
 * runs over.
 *
 * 5 bits per channel, so at most 32768 distinct weighted samples instead of
 * however many thousand texels a sheet holds. The clustering is unchanged in
 * any way that survives an 8-bit output — the bucket is 8 units wide and the
 * centroids are recomputed from the bucket MEANS, not from the bucket centres,
 * so the only thing lost is the tie-break between two texels 3 units apart.
 */
const HIST_BITS = 5;
const HIST_SHIFT = 8 - HIST_BITS;

interface Sample {
  lab: Oklab;
  r: number;
  g: number;
  b: number;
  w: number;
}

/** Weighted histogram of every opaque texel across every cell. */
function histogram(cells: readonly RawImage[]): Sample[] {
  const acc = new Map<number, { r: number; g: number; b: number; w: number }>();
  for (const c of cells) {
    const d = c.data;
    for (let p = 0; p < c.width * c.height; p++) {
      if (d[p * 4 + 3] <= OPAQUE_CUTOFF) continue;
      const r = d[p * 4], g = d[p * 4 + 1], b = d[p * 4 + 2];
      const key = ((r >> HIST_SHIFT) << (HIST_BITS * 2)) | ((g >> HIST_SHIFT) << HIST_BITS) | (b >> HIST_SHIFT);
      const hit = acc.get(key);
      if (hit) { hit.r += r; hit.g += g; hit.b += b; hit.w++; }
      else acc.set(key, { r, g, b, w: 1 });
    }
  }
  const out: Sample[] = [];
  for (const v of acc.values()) {
    const r = v.r / v.w, g = v.g / v.w, b = v.b / v.w;
    out.push({ lab: oklab(r, g, b), r, g, b, w: v.w });
  }
  // Sorted so the seeding below is a pure function of the pixels and not of
  // Map iteration order — a derived palette has to be reproducible or the
  // published sheet changes every time somebody re-runs the forge.
  out.sort((a, b2) => b2.w - a.w || a.r - b2.r || a.g - b2.g || a.b - b2.b);
  return out;
}

/**
 * k-means++ seeding, DETERMINISTIC — farthest-point rather than the usual
 * randomised D² draw.
 *
 * The randomised version is better on adversarial inputs and unusable here: a
 * published sprite sheet that changes colour every time the forge runs is not
 * an artifact anybody can review or diff. Farthest-point is the deterministic
 * limit of the same idea and, on a colour histogram whose clusters are already
 * well separated, lands in the same basins.
 *
 * The first seed is the HEAVIEST colour, not an arbitrary one: on a sprite that
 * is the body, and starting from the body means the first split is body-vs-rest
 * rather than two halves of one accent.
 */
function seed(samples: readonly Sample[], k: number, fixed: readonly Oklab[]): Oklab[] {
  const centres: Oklab[] = [...fixed];
  const best = new Float64Array(samples.length).fill(Infinity);
  const push = (c: Oklab): void => {
    centres.push(c);
    for (let i = 0; i < samples.length; i++) {
      const d = oklabDist(samples[i].lab, c);
      if (d < best[i]) best[i] = d;
    }
  };
  for (const f of fixed) {
    for (let i = 0; i < samples.length; i++) {
      const d = oklabDist(samples[i].lab, f);
      if (d < best[i]) best[i] = d;
    }
  }
  if (!centres.length && samples.length) push(samples[0].lab);
  while (centres.length < k && centres.length < samples.length + fixed.length) {
    // Weighted farthest point: a heavy cluster that is merely far is a better
    // seed than one stray texel at the edge of the gamut, which is what plain
    // farthest-point would pick every time (and it would pick the same fringe
    // artifact on every sheet).
    let at = -1;
    let score = -1;
    for (let i = 0; i < samples.length; i++) {
      const s = best[i] * Math.sqrt(samples[i].w);
      if (s > score) { score = s; at = i; }
    }
    if (at < 0 || score <= 0) break;
    push(samples[at].lab);
  }
  return centres;
}

export interface DerivedPalette {
  /** sRGB triplets. Entry 0 is always ink. */
  rgb: number[][];
  /** Share of opaque texels each entry ended up carrying. Same order. */
  share: number[];
}

/**
 * Derive an `n`-entry palette from the texels a commit is about to snap.
 *
 * `n` counts the pinned ink, so `derivePalette(cells, 20)` is 1 ink + 19
 * clustered — the same 20 slots the shared palette lock allows, spent on this
 * creature alone.
 */
export function derivePalette(cells: readonly RawImage[], n: number): DerivedPalette {
  if (n < 2) throw new Error("[palette-derive] a palette needs at least ink and one colour");
  const samples = histogram(cells);
  const inkLab = oklab(INK_RGB[0], INK_RGB[1], INK_RGB[2]);
  if (!samples.length) return { rgb: [[...INK_RGB]], share: [0] };

  const centres = seed(samples, n, [inkLab]);
  const rgbOf: number[][] = centres.map((c, i) => (i === 0 ? [...INK_RGB] : [0, 0, 0]));

  // ── Lloyd, in OKLab, weighted, with the ink centroid PINNED ───────────────
  //
  // Pinned means it attracts texels but never moves toward them. A sheet whose
  // darkest region is a deep blue cloak would otherwise drag "ink" to navy and
  // the silhouette would stop matching the roster.
  const assign = new Int32Array(samples.length).fill(-1);
  for (let iter = 0; iter < 24; iter++) {
    let moved = 0;
    for (let i = 0; i < samples.length; i++) {
      let bestI = 0;
      let bd = Infinity;
      for (let c = 0; c < centres.length; c++) {
        const d = oklabDist(samples[i].lab, centres[c]);
        if (d < bd) { bd = d; bestI = c; }
      }
      if (assign[i] !== bestI) { assign[i] = bestI; moved++; }
    }
    // Recompute in sRGB and re-enter OKLab: the palette entry that ships is an
    // 8-bit sRGB triple, so averaging in the space the OUTPUT lives in is what
    // keeps the centroid and the shipped colour the same thing.
    const sum = centres.map(() => ({ r: 0, g: 0, b: 0, w: 0 }));
    for (let i = 0; i < samples.length; i++) {
      const a = sum[assign[i]];
      const s = samples[i];
      a.r += s.r * s.w; a.g += s.g * s.w; a.b += s.b * s.w; a.w += s.w;
    }
    for (let c = 1; c < centres.length; c++) {
      if (!sum[c].w) continue;
      const r = sum[c].r / sum[c].w, g = sum[c].g / sum[c].w, b = sum[c].b / sum[c].w;
      rgbOf[c] = [Math.round(r), Math.round(g), Math.round(b)];
      centres[c] = oklab(rgbOf[c][0], rgbOf[c][1], rgbOf[c][2]);
    }
    if (!moved && iter > 0) break;
  }

  // ── Drop the empties, then order the palette so a human can read it ───────
  //
  // Ink first, then by LIGHTNESS. A palette dump that runs dark-to-light shows
  // the creature's ramps as contiguous runs; one in cluster-discovery order
  // shows nothing, and the sidecar is meant to be edited by hand.
  const weight = centres.map(() => 0);
  for (let i = 0; i < samples.length; i++) weight[assign[i]] += samples[i].w;
  const total = weight.reduce((a, b) => a + b, 0) || 1;
  const kept = centres
    .map((_, c) => c)
    .filter((c) => c === 0 || weight[c] > 0)
    .sort((a, b) => (a === 0 ? -1 : b === 0 ? 1 : centres[a].L - centres[b].L));
  return {
    rgb: kept.map((c) => rgbOf[c]),
    share: kept.map((c) => weight[c] / total),
  };
}

/** `#rrggbb` for a triplet, for the manifest and for report tables. */
export function hexOf(c: readonly number[]): string {
  return `#${c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;
}

/** `#rrggbb` → triplet. The manifest ships hex; the crush wants bytes. */
export function rgbOfHex(hex: string): number[] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
