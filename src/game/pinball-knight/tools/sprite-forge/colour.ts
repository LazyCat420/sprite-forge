/**
 * COLOUR DISTANCE FOR THE GRID COMMIT — and why the old one made everything grey.
 *
 * The snap that turns a resampled cell into palette indices used a LUMA-WEIGHTED
 * squared distance in sRGB:
 *
 *     d² = (Δr·0.30)² + (Δg·0.59)² + (Δb·0.11)²
 *
 * That is a BRIGHTNESS match wearing the shape of a colour match. Blue is
 * discounted to a ninth of green, so two colours that differ only in blue are
 * treated as nearly identical — and "nearest palette entry" collapses to
 * "entry with the closest luma", whichever ramp it belongs to.
 *
 * MEASURED on the imported knight (2026-08-03), source figure against what
 * shipped, mean saturation:
 *
 *     source, native                 0.399
 *     after the reduce               0.44     <- the downscale RAISES it
 *     after the snap + evict + ban   0.318    <- 28% gone, all of it here
 *
 * The code already half-knew: `CommitOptions.ban` exists because "the metric
 * discounts blue to 0.11, so warm-grey armor matches the rot ramp". That fix
 * removed the ramp the metric kept reaching for instead of fixing the reach.
 *
 * OKLab is the replacement — but ⚠️ IT DOES NOT RECOVER THE SATURATION, and the
 * paragraph above is the trap it was written into. Measured over the same
 * figure: luma keeps 77% of the source's mean saturation, OKLab 75%. Chasing
 * the metric was chasing the wrong half. A 20-of-32 fixed palette cannot hold
 * a 1600-colour figure's chroma no matter how the nearest entry is chosen; the
 * saturation is spent by the PALETTE, and the only arm that raised it (86%) did
 * so by pushing the armour onto `arcane`, a saturated cold blue — a lie that
 * scores well and comes back speckled with blue confetti.
 *
 * OKLab ships on a smaller, true claim: it keeps a MATERIAL on its own ramp,
 * because it is perceptually uniform and chroma carries the same weight as
 * lightness rather than a ninth of it. The knight's brow arrives as `skin`
 * rather than as `torch` flame, his straps as `leather` rather than ember, and
 * one input that scattered to 21+ palette entries under luma consolidates to 19.
 *
 * The thing that actually fixed "muddy" was not here at all: it is
 * `CommitOptions.presharpen`, local contrast raised BEFORE the reduce so the
 * k-centroid has a decisive vote to count. The eye becomes an eye at 0.8.
 *
 * `CHROMA_BOOST` then leans the metric further toward hue than plain OKLab
 * does. Justification is the palette, not taste: this is a 32-entry palette
 * holding EIGHT ramps separated by hue, with two of them (stone 2-5, steel
 * 19-22) sitting almost on top of each other in lightness. Under any
 * lightness-first metric those two interleave — measured, the knight's armour
 * landed 33% on `stone` (the ENVIRONMENT ramp, flat blue-grey) against 13% on
 * `steel` (whose warm-dark/cold-light spread is the thing that reads as metal).
 * Weighting the a/b axes above L is what keeps a material on its own ramp.
 */

/** One sRGB byte → linear light. */
function lin(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

export interface Oklab {
  L: number;
  a: number;
  b: number;
}

/** sRGB (0-255) → OKLab. Björn Ottosson's matrices, unmodified. */
export function oklab(r: number, g: number, b: number): Oklab {
  const R = lin(r);
  const G = lin(g);
  const B = lin(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

/**
 * How much more the hue axes count than lightness.
 *
 * 1.0 is plain OKLab. Swept over the knight (see `snap-metric.test.ts`); 2.0
 * moves the armour onto its own ramp without letting a dark accent snap to a
 * bright one of the same hue, which is what >3 starts doing.
 */
export const CHROMA_BOOST = 2.0;

/** Squared OKLab distance with the chroma axes weighted up. Order-preserving. */
export function oklabDist(p: Oklab, q: Oklab): number {
  const dL = p.L - q.L;
  const da = (p.a - q.a) * CHROMA_BOOST;
  const db = (p.b - q.b) * CHROMA_BOOST;
  return dL * dL + da * da + db * db;
}

/** The legacy luma-weighted sRGB distance, kept so the A/B has a control arm. */
export function lumaDist(a: readonly number[], b: readonly number[]): number {
  const dr = (a[0] - b[0]) * 0.3;
  const dg = (a[1] - b[1]) * 0.59;
  const db = (a[2] - b[2]) * 0.11;
  return dr * dr + dg * dg + db * db;
}

export type SnapMetric = "luma" | "oklab";

/**
 * A reusable snapper over a fixed palette and a fixed set of allowed entries.
 *
 * Built once per commit rather than per texel: the OKLab conversion of the
 * palette is the expensive half and it does not change.
 */
export function makeSnapper(
  pal: readonly (readonly number[])[],
  metric: SnapMetric,
  allowed?: ReadonlySet<number>,
): { snap: (r: number, g: number, b: number) => number; dist: (i: number, j: number) => number } {
  const ids = pal.map((_, i) => i).filter((i) => !allowed || allowed.has(i));
  if (!ids.length) throw new Error("[colour] no allowed palette entries");
  const lab = pal.map((p) => oklab(p[0], p[1], p[2]));

  const dist = (i: number, j: number): number =>
    metric === "oklab" ? oklabDist(lab[i], lab[j]) : lumaDist(pal[i], pal[j]);

  if (metric === "luma") {
    return {
      dist,
      snap: (r, g, b) => {
        let best = ids[0];
        let bd = Infinity;
        for (const i of ids) {
          const d = lumaDist([r, g, b], pal[i]);
          if (d < bd) { bd = d; best = i; }
        }
        return best;
      },
    };
  }
  return {
    dist,
    snap: (r, g, b) => {
      const q = oklab(r, g, b);
      let best = ids[0];
      let bd = Infinity;
      for (const i of ids) {
        const d = oklabDist(q, lab[i]);
        if (d < bd) { bd = d; best = i; }
      }
      return best;
    },
  };
}
