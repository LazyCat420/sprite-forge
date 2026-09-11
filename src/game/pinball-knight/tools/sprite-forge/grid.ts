/**
 * THE GATE — does this sheet actually have pixels?
 *
 * Everything downstream of the forge assumes a source image can be reduced to
 * the atlas without inventing anything. That is only true if the art is REAL
 * pixel art: a lattice of N×N blocks, each one flat, so an N→1 block reduce is
 * exact rather than a guess. Generated "pixel art" usually is not. It LOOKS
 * blocky and is actually continuous — irregular blob edges with anti-aliased
 * seams — and every resample after that is damage no filter can undo.
 *
 * Measured on the shipped jester sheet before this existed: 61.6% of horizontal
 * colour changes were one pixel apart, decaying monotonically (2px 14.5%, 3px
 * 6.5%). A true ×8 upscale puts 100% of them exactly 8 apart. So the sheet had
 * no grid at all, and "make the import 1:1" was unanswerable — there was
 * nothing on the source side to be 1:1 WITH.
 *
 * ── HOW IT DECIDES ──────────────────────────────────────────────────────────
 *
 * A ×N upscale has one property nothing else has: every colour change sits on a
 * lattice line, i.e. at some x where `x % N === phase`. So for each candidate N
 * we take the BEST phase and ask what share of changes land on it.
 *
 *     score(N) = max over phase of  (changes at that phase) / (all changes)
 *
 * Chance alone gives 1/N (the changes are spread over N phases), so the score
 * is normalised against that floor:
 *
 *     confidence(N) = (score − 1/N) / (1 − 1/N)
 *
 * 1.0 means every change is on the lattice; 0.0 means no better than random.
 * That normalisation is what makes the numbers comparable ACROSS N — a raw
 * score of 0.5 is superb at N=16 and worthless at N=2.
 *
 * Both axes are measured and the WEAKER one is reported, because a sheet that
 * is gridded horizontally and smeared vertically is not reducible either.
 *
 * Ties go to the LARGEST N: a ×8 upscale also scores perfectly at N=2 and N=4
 * (every 8-lattice line is also a 4- and a 2-lattice line), and the largest
 * passing factor is the true block size.
 */

/** Structural stand-in for ImageData — node has no global for it. */
export interface RawImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface GridReport {
  /** The block size, in source pixels. 1 = native-resolution pixel art. */
  factor: number;
  /** 0..1, normalised against chance. See the header. */
  confidence: number;
  /** Confidence for every candidate, for the report and for tests. */
  scores: { factor: number; confidence: number }[];
  /** Share of neighbouring pixels that are byte-identical. See the verdict block. */
  flatShare: number;
  /**
   * Share of an N×N block that is its own plurality colour, 0..1.
   *
   * 1.0 means every block is flat and the reduce is lossless; ~0.07 means the
   * blocks hold a dozen colours each and there is no lattice to snap to. See
   * `cellPurity` for why this is reported instead of peak regularity.
   */
  cellPurity: number;
  /** The factor `cellPurity` was measured at — the winner, or the best failing candidate. */
  purityFactor: number;
  /** True when the art can be block-reduced exactly. */
  gridded: boolean;
  /** One line for the forge report, in the player's language. */
  verdict: string;
}

/** Largest block size worth testing. Past this a "block" is a shape, not a pixel. */
const MAX_FACTOR = 16;

/**
 * Confidence a sheet must clear to be called gridded.
 *
 * 0.90, not 0.99: a real ×N sheet saved as PNG through a generator picks up a
 * few stray pixels at silhouette edges, and demanding perfection would reject
 * art that block-reduces cleanly. Below 0.90 the lattice is not carrying the
 * image and the reduce would be inventing.
 */
export const GRID_CONFIDENCE = 0.9;

/** A colour change big enough to be an edge rather than a gradient step. */
const EDGE = 40;

/**
 * CELL PURITY — the share of a block that IS its own plurality colour.
 *
 * Borrowed from Sprite Fusion's Pixel Snapper, which cuts an image on detected
 * gradient peaks and takes the plurality colour per cell. Its estimator is
 * drift-tolerant where ours is not (we score PHASE against a uniform lattice),
 * so it was worth checking whether it finds a grid we throw away.
 *
 * It does not — but the check produced a better metric than the one we had.
 * Measured, with a synthetic ×8 fixture as the positive control:
 *
 *     synthetic ×8 pixel art      step 8.0   regularity 1.00   purity 1.000
 *     live jester-S               step 5.0   regularity 0.79   purity 0.068
 *     live beaver-S               step 5.0   regularity 0.85   purity 0.067
 *     round-2 generated jester    step 4.0   regularity 0.62   purity 0.083
 *
 * ⚠️ NOTE WHAT REGULARITY DOES. 0.79 of the peak spacings sit within a pixel of
 * the median — that reads as a healthy grid, and there is no grid. A tool that
 * gates on peak regularity alone snaps our sheets to a 5px lattice and emits
 * mush, confidently and silently. That is the argument for a gate that can
 * REFUSE, and it is why regularity is deliberately NOT adopted here.
 *
 * Purity is adopted because it measures the property that actually matters:
 * whether a block can collapse to one colour without losing anything. It is
 * also far easier to read than a phase confidence — "each cell is 7% its own
 * colour" needs no explaining.
 */
function cellPurity(img: RawImage, n: number, boxes: readonly (readonly number[])[]): number {
  if (n < 2) return 1;
  const tally = new Map<number, number>();
  const scores: number[] = [];
  for (const [bx0, by0, bx1, by1] of boxes) {
    for (let y = by0; y + n - 1 <= by1; y += n) {
      for (let x = bx0; x + n - 1 <= bx1; x += n) {
        tally.clear();
        let best = 0;
        let total = 0;
        for (let dy = 0; dy < n; dy++) {
          for (let dx = 0; dx < n; dx++) {
            const i = ((y + dy) * img.width + x + dx) * 4;
            if (img.data[i + 3] <= 127) continue;
            const key = (img.data[i] << 16) | (img.data[i + 1] << 8) | img.data[i + 2];
            const c = (tally.get(key) ?? 0) + 1;
            tally.set(key, c);
            if (c > best) best = c;
            total++;
          }
        }
        // Only fully-opaque blocks: a block straddling the silhouette is mostly
        // background and would score as pure for the wrong reason.
        if (total === n * n) scores.push(best / total);
      }
    }
  }
  return scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
}

/**
 * Flat-neighbour share above which un-gridded art is called NATIVE pixel art
 * rather than continuous. Calibrated, not guessed — see the verdict block.
 */
export const NATIVE_FLAT_SHARE = 0.55;

/** Share of horizontally-adjacent pixel pairs that are byte-identical. */
function flatShare(img: RawImage, boxes: readonly (readonly number[])[]): number {
  let same = 0;
  let n = 0;
  for (const [x0, y0, x1, y1] of boxes) {
    for (let y = y0; y <= y1; y++) {
      for (let x = x0 + 1; x <= x1; x++) {
        const i = (y * img.width + x) * 4;
        const j = (y * img.width + x - 1) * 4;
        if (
          img.data[i] === img.data[j] &&
          img.data[i + 1] === img.data[j + 1] &&
          img.data[i + 2] === img.data[j + 2] &&
          img.data[i + 3] === img.data[j + 3]
        ) {
          same++;
        }
        n++;
      }
    }
  }
  return n ? same / n : 0;
}

function changePositions(img: RawImage, axis: "x" | "y", box: readonly number[]): number[] {
  const [x0, y0, x1, y1] = box;
  const { width, data } = img;
  const out: number[] = [];
  const along = axis === "x" ? x1 - x0 : y1 - y0;
  const across = axis === "x" ? y1 - y0 : x1 - x0;
  for (let a = 0; a <= across; a++) {
    for (let b = 1; b <= along; b++) {
      const [px, py] = axis === "x" ? [x0 + b, y0 + a] : [x0 + a, y0 + b];
      const [qx, qy] = axis === "x" ? [x0 + b - 1, y0 + a] : [x0 + a, y0 + b - 1];
      const i = (py * width + px) * 4;
      const j = (qy * width + qx) * 4;
      const d =
        Math.abs(data[i] - data[j]) +
        Math.abs(data[i + 1] - data[j + 1]) +
        Math.abs(data[i + 2] - data[j + 2]) +
        Math.abs(data[i + 3] - data[j + 3]);
      // The absolute position matters, not the position within the box: the
      // lattice belongs to the SHEET, so cells must agree about its phase.
      if (d > EDGE) out.push(axis === "x" ? x0 + b : y0 + b);
    }
  }
  return out;
}

/** Best-phase share for one candidate factor, normalised against chance. */
function confidenceFor(positions: readonly number[], n: number): number {
  if (n === 1) return 1; // every integer is on the 1-lattice; native art is trivially gridded
  if (!positions.length) return 0;
  const bins = new Array<number>(n).fill(0);
  for (const p of positions) bins[((p % n) + n) % n]++;
  const best = Math.max(...bins) / positions.length;
  return (best - 1 / n) / (1 - 1 / n);
}

/**
 * Measure the source's intrinsic pixel size over the given cell boxes.
 *
 * `boxes` are the sliced cells rather than the whole sheet: the background is
 * flat, contributes no colour changes, and would only dilute the sample.
 */
export function detectPixelGrid(img: RawImage, boxes: readonly (readonly number[])[]): GridReport {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const b of boxes) {
    xs.push(...changePositions(img, "x", b));
    ys.push(...changePositions(img, "y", b));
  }

  const scores: { factor: number; confidence: number }[] = [];
  for (let n = 2; n <= MAX_FACTOR; n++) {
    // The WEAKER axis decides. Gridded one way and smeared the other is not
    // reducible, and reporting the stronger axis would flatter exactly the
    // sheets most likely to be mis-authored.
    scores.push({ factor: n, confidence: Math.min(confidenceFor(xs, n), confidenceFor(ys, n)) });
  }

  // Largest passing factor wins — a x8 sheet also scores 1.0 at 4 and 2.
  const passing = scores.filter((s) => s.confidence >= GRID_CONFIDENCE);
  const best = passing.length ? passing[passing.length - 1] : null;
  const factor = best ? best.factor : 1;
  const confidence = best ? best.confidence : 0;

  // A sheet with no lattice is either NATIVE-RESOLUTION pixel art or CONTINUOUS
  // art, and those two need opposite advice — so the verdict needs a second
  // measurement to tell them apart.
  //
  // Edge DENSITY cannot do it: per-pixel noise scores as high as hand-placed
  // pixels, and the first version of this file called a noise fixture "native
  // pixel art" for exactly that reason. The property that actually separates
  // them is FLATNESS — pixel art is regions of byte-identical pixels bounded by
  // hard edges, and no amount of noise or gradient produces those runs.
  //
  // Calibrated on real input rather than guessed (see grid.test.ts):
  //
  //     synthetic x6 pixel art        0.842
  //     the shipped jester sheet      0.324   ← styled, but NOT pixel art
  //     noisy gradient                0.009
  //     smooth gradient               0.000
  //
  // 0.55 sits in the empty band between the real sheet and true pixel art.
  const flat = flatShare(img, boxes);

  let verdict: string;
  if (best) {
    verdict =
      `PIXEL GRID ×${factor} (confidence ${(confidence * 100).toFixed(1)}%) — ` +
      `block-reduce is EXACT; this sheet can import 1:1.`;
  } else if (flat >= NATIVE_FLAT_SHARE) {
    verdict =
      `NO BLOCK GRID, but ${(flat * 100).toFixed(0)}% of neighbouring pixels are identical — ` +
      `this reads as NATIVE-RESOLUTION pixel art. It imports 1:1 only if the cell height ` +
      `already equals the atlas texel height; otherwise re-author it at an integer multiple.`;
  } else {
    const top = scores.reduce((a, b) => (b.confidence > a.confidence ? b : a));
    verdict =
      `NOT PIXEL ART — no lattice (best ×${top.factor} at ${(top.confidence * 100).toFixed(1)}%, ` +
      `need ${(GRID_CONFIDENCE * 100).toFixed(0)}%) and only ${(flat * 100).toFixed(0)}% flat neighbours. ` +
      `Continuous/anti-aliased art: it will be RESAMPLED, not reduced, and CANNOT import 1:1. ` +
      `Re-generate with hard edges, no anti-aliasing, at an integer multiple of the target size.`;
  }

  // Purity at the factor the sheet CLAIMS — the winning one if it passed, else
  // the best-scoring candidate, so a failing sheet still reports how far off it
  // was rather than reporting nothing.
  const claimed = best ? factor : scores.reduce((a, b) => (b.confidence > a.confidence ? b : a)).factor;
  const purity = cellPurity(img, claimed, boxes);

  return {
    factor, confidence, scores, flatShare: flat, cellPurity: purity, purityFactor: claimed,
    gridded: Boolean(best),
    verdict: verdict + ` Cell purity at ×${claimed}: ${(purity * 100).toFixed(1)}%` +
      (best ? "." : ` — a real lattice is ~100%, so the blocks are ${purity < 0.5 ? "mush" : "close but not flat"}.`),
  };
}

/**
 * Exact N→1 block reduce. Only valid when `detectPixelGrid` said so.
 *
 * Each output pixel is the MAJORITY colour of its block, not the average: on
 * true pixel art the block is already flat so majority returns it unchanged
 * (that is what "exact" means here), while on a block with a stray edge pixel
 * majority keeps the intended colour where an average would invent a new one.
 *
 * `ox`/`oy` are the lattice PHASE — the offset of the first whole block. A
 * sheet whose art does not start at (0,0) still reduces correctly.
 */
export function blockReduce(img: RawImage, n: number, ox = 0, oy = 0): RawImage {
  const w = Math.max(1, Math.floor((img.width - ox) / n));
  const h = Math.max(1, Math.floor((img.height - oy) / n));
  const out: RawImage = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  const tally = new Map<number, number>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      tally.clear();
      let bestKey = 0;
      let bestN = 0;
      for (let by = 0; by < n; by++) {
        for (let bx = 0; bx < n; bx++) {
          const i = ((oy + y * n + by) * img.width + (ox + x * n + bx)) * 4;
          const key =
            (img.data[i] << 24) | (img.data[i + 1] << 16) | (img.data[i + 2] << 8) | img.data[i + 3];
          const c = (tally.get(key) ?? 0) + 1;
          tally.set(key, c);
          if (c > bestN) {
            bestN = c;
            bestKey = key;
          }
        }
      }
      const o = (y * w + x) * 4;
      out.data[o] = (bestKey >>> 24) & 0xff;
      out.data[o + 1] = (bestKey >>> 16) & 0xff;
      out.data[o + 2] = (bestKey >>> 8) & 0xff;
      out.data[o + 3] = bestKey & 0xff;
    }
  }
  return out;
}
