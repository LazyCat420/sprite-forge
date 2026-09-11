/**
 * THE GRID COMMIT — the step that makes a generated sheet importable at all.
 *
 * `grid.ts` can only report. It measured every sheet this project has received
 * as NOT PIXEL ART, and the obvious response — ask the generator for pixel art —
 * was tried and MEASURED. Round 2 asked in capitals for no anti-aliasing, flat
 * fills and at most 16 colours, and returned:
 *
 *     distinct colours   204,201 -> 301,541    (16 were requested)
 *     flat neighbours         11% -> 15%       (55% to pass the gate)
 *     census entries        26.6 -> 30.7       (the atlas locks 20)
 *     census isolated%     41.5% -> 47.8%      (painted roster 22.5%)
 *
 * Every number moved the wrong way while the art got visibly better, because a
 * generator emits a continuous-tone RENDERING of flat pixel art: each
 * apparently-flat block is a gradient of hundreds of near-identical values, and
 * the luma-weighted snap sends each of them to a DIFFERENT palette index. Not a
 * transport artifact either — JPEG blockiness measured 1.022, where >1.15 would
 * mean recompression.
 *
 * So neither property can be requested. Both are IMPOSED here, once, offline:
 *
 *   1. reduce each cell to the texel count it will actually occupy
 *   2. snap to the real palette and evict down to the atlas lock
 *   3. nearest-upscale by `factor`, on a lattice the whole SHEET agrees about
 *
 * After step 3 the sheet passes `detectPixelGrid`, and `blockReduce` recovers
 * step 2's texels EXACTLY — which is what "1:1 import" means. The pixels the
 * artist reviews here are the pixels the player sees, at every camera rung.
 *
 * ── WHY OFFLINE AND NOT AT RUNTIME ─────────────────────────────────────────
 *
 * The runtime already resamples, so this could in principle happen on load. It
 * must not. A commit is a destructive, opinionated decision — which 20 of 32
 * colours survive — and the artist has to be able to LOOK at the result and
 * repair it. Doing it per-boot also redoes the same work forever and hides the
 * eviction inside a frame budget. Committing once writes an artifact that can
 * be diffed, censused and rejected.
 *
 * Pure: pixels in, pixels out. No filesystem, no node-canvas.
 *
 * ⚠️ THE SNAP NO LONGER COMES FROM THE ENGINE, and that is deliberate. It used
 * to call the engine's `snapColor` so a tool could not drift from the game's own
 * metric. But the engine's snap runs per frame on a LUT and is tuned for the 3D
 * pass; the commit runs once, offline, on a few thousand texels, and can afford
 * a perceptual metric the runtime cannot. Since a committed sheet arrives at the
 * atlas already sitting on exact palette colours, the runtime crush snaps it to
 * itself — the two never disagree about a shipped texel. See `colour.ts`.
 */
import { resampleCell, type RawImage } from "./resample";
import { ART_BOX, ART_FIT_H, ART_FIT_W, ART_GROUND, VOTING_CLIPS, type ManifestRow } from "./manifest";
import { sliceSheet, type Cell } from "./slice";
import { makeSnapper, type SnapMetric } from "./colour";
import { derivePalette, INK_RGB } from "./palette-derive";
import { synthCell, type SynthOptions } from "./synth";

export type { RawImage };

/**
 * Alpha at or below which a committed texel is CLEAR.
 *
 * Mirrors `atlas-census.OPAQUE_CUTOFF`. Alpha is binarised rather than carried:
 * a block whose alpha varies is not flat, and a sheet whose alpha is not flat
 * fails its own gate on the alpha channel even when every RGB block is perfect.
 */
const OPAQUE_CUTOFF = 127;

/**
 * The camera rung a commit sizes for, in atlas texels.
 *
 * `SPRITE_PIXEL_GRID` is `PPU * 3/2`, so `CAMERA_ZOOMS` runs {120, 108, 96, 84,
 * 72} and the DEFAULT is 84 (`CAMERA_ZOOM_DEFAULT = "wider"`, PPU 56). This is
 * the rung to size for. See `oneToOneScale` — the TEXEL count of a committed
 * sheet is rung-INDEPENDENT, so this constant alone decides the figure's
 * resolution, everywhere, forever.
 *
 * ⚠️ TWICE NOW THIS HAS BEEN THE "KNIGHT IS TINY" BUG, for two different
 * reasons, and the second one is the interesting one:
 *
 *   · 54 (fixed 2026-08-03) outlived the 9/8 sprite ladder {90, 81, 72, 63, 54}
 *     it was written for. The knight shipped 46 texels at every zoom.
 *   · 72 (fixed 2026-08-03, this change) was a deliberate choice of the WIDEST
 *     rung, on the argument that the tightest fit constraint must hold at all
 *     five so `fitsArtBox` never falls back. It bought that guarantee with 20%
 *     of the figure's linear resolution at the rung people actually play:
 *
 *         rung   imported (fitGrid 72)   painted actor   share
 *          120       32×60 texels         68×115          52%
 *           84       32×60 texels         47× 80          75%   <- DEFAULT
 *
 *     Measured through `paintInArtSpace` → `crushToGrid`, both at the same
 *     rung. The player's report was "the main character is still a blur", and
 *     it was: 1315 opaque texels against the procedural knight's 2301 standing
 *     beside him.
 *
 * At 84 the budget is `floor(110 × 84 / 128)` = 72 texels — +20% linear, +44%
 * area — and `fitsArtBox` still passes at 84/96/108/120 (109.71 art units
 * against the 110 limit at 84, which is what the `Math.floor` below is for).
 * The WIDEST rung, 72, no longer fits 1:1 and takes the fitted k-centroid
 * resample every other imported creature already takes. That is the right end
 * to spend it: `widest` is the rung where the actor is smallest on screen, so
 * it is where a fractional reduce costs the least — and it is not the default.
 *
 * When the ladder moves, this constant and `commit.test.ts`'s rung arrays move
 * with it.
 */
export const FIT_GRID = 84;

/** The atlas entry lock every monster sheet is held to. Mirrors `boot/sheets.ts`. */
export const MAX_ENTRIES = 20;

/** Default block size. ×8 is the authoring factor `PROMPTS.md` asks for. */
export const DEFAULT_FACTOR = 8;

export interface CommitOptions {
  /** Source pixels per committed texel. */
  factor?: number;
  /** Atlas grid to size the fit against. See `FIT_GRID`. */
  fitGrid?: number;
  /** Distinct palette entries the sheet may keep. See `MAX_ENTRIES`. */
  maxEntries?: number;
  /** Blank texels between cells. ≥1 so the slicer can separate them again. */
  gutter?: number;
  /**
   * Skip the post-evict despeckle pass. On by default: a texel whose colour no
   * orthogonal neighbour shares is almost always a resample artifact, and one
   * adoption pass measurably lowers `isolated%` without touching real accents
   * (the distance gate below protects them). Off for sheets whose art is
   * legitimately 1-px speckled (sparkles, static).
   */
  noDespeckle?: boolean;
  /**
   * Palette entries this sheet may NOT use — a MATERIAL decision, not a colour
   * one. Measured on the knight (2026-08-03, palette-ab): the luma-weighted
   * snap discounts blue to 0.11, so warm-grey armor matches the rot ramp and
   * ~12% of crushed texels came out zombie-green. No source-space grade can fix
   * that (killing the green cast measured IDENTICAL to no grade), because the
   * intent "this creature owns no rot" is metadata the pixels do not carry.
   * Banned entries are remapped to their nearest allowed entry under the snap's
   * own metric, BEFORE the evict, so they never hold a lock slot.
   */
  ban?: readonly number[];
  /**
   * Which colour metric decides "nearest palette entry". See `colour.ts`.
   *
   * `oklab` is the default; `luma` is the legacy sRGB brightness match, kept as
   * the A/B control arm.
   *
   * ⚠️ THE METRIC IS THE SMALL HALF. It was chased first, on the measurement
   * that the snap costs the knight 28% of his saturation — and swapping it
   * recovers almost none of that (75% of source against luma's 77%). What the
   * snap cannot do is invent colours a 20-of-32 palette does not have; the
   * saturation goes to the PALETTE, not to how the palette is searched.
   *
   * `oklab` ships anyway, on a smaller and more defensible claim: it keeps a
   * material on its own ramp. The knight's brow arrives as skin rather than as
   * flame, his straps as leather rather than as ember, and it consolidates
   * where luma scatters (the commit.test fixture fell 21+ entries → 19 on the
   * same input). See `snap-metric.test.ts` for the arms, including the one that
   * scored best on every family metric and was REJECTED by looking at it.
   */
  metric?: SnapMetric;
  /**
   * Local-contrast boost applied to the source cell BEFORE the reduce.
   *
   * ⚠️ BEFORE, WHICH IS THE WHOLE POINT. Sharpening after a downscale can only
   * exaggerate the texels the reduce already chose — it cannot recover a feature
   * the reduce averaged away, and at this scale it mostly manufactures halos.
   * Sharpening BEFORE changes what the k-centroid has to VOTE on: an eye that is
   * a slightly-darker smudge across three source pixels becomes a decisively
   * darker one, and wins its texel instead of tying with the cheek.
   *
   * Unsharp on LUMA only, with RGB scaled by L'/L, so a boosted pixel moves
   * along a ray from the origin and cannot change hue family. `sprite.ts`
   * already learned that lesson the expensive way — its per-channel sharpen
   * measured as "chroma confetti" and was set to 0.
   *
   * 0 disables the pass entirely. See `presharpen-ab` in snap-metric.test.ts.
   */
  presharpen?: number;
  /**
   * Absorb same-colour REGIONS smaller than this many texels into the
   * neighbour they share the most border with. 0 disables the pass.
   *
   * The despeckle above only ever caught a component of ONE texel with no
   * matching orthogonal neighbour. What separates a Ragnarok Online or Golden
   * Sun sprite from ours is not the orphan count — it is that their colour
   * regions are LARGE and flat, with deliberate one-texel outlines, where a
   * downsampled painting arrives as a mosaic of 2-4 texel patches that reads as
   * melting. `isolated%` cannot see that: a 3-texel blob has neighbours of its
   * own colour, so every texel in it passes the orphan test.
   *
   * ⚠️ THE ACCENT GATE IS LOAD-BEARING, AND THE EYE IS THE TEST CASE. A pupil
   * is a small, high-contrast region — exactly the shape this pass absorbs — so
   * a component is only absorbed when its colour is CLOSE to the neighbour
   * taking it (`REGION_NEAR`). A white glint on dark armour and a black pupil
   * in a tan face are far from everything around them and survive; a
   * near-identical grey patch beside a slightly different grey dies, which is
   * the whole point.
   */
  minRegion?: number;
  /**
   * How the source becomes texels.
   *
   * `vote` (default) is the shipped path: k-centroid reduce, one winner per
   * texel. `synth` decides REGIONS first and colours them — see `synth.ts` for
   * why that is a different question and not a better filter.
   */
  mode?: "vote" | "synth";
  /** Tuning for `mode: "synth"`. Ignored otherwise. */
  synth?: SynthOptions;
  /**
   * Ink the silhouette: every texel with a transparent orthogonal neighbour
   * becomes the palette's outline entry.
   *
   * `synth` already does this as part of its own construction. This makes it
   * available to the VOTE path, because the two halves of the Ragnarok read —
   * flat regions, and a deliberate one-texel edge around them — are separable,
   * and it had never been tested whether the EDGE ALONE is what reads as clean.
   * A vote-reduced sheet keeps all of its internal texture and gains the rim.
   *
   * ⚠️ It costs a texel of silhouette on every limb, which at ~70 texels tall
   * is visible on thin features. It is also not additive with the runtime's
   * `selout` pass, which blends the shadow-side rim 60% toward ink: a texel
   * that is already ink stays ink when selout reaches it.
   */
  outline?: boolean;
  /**
   * Give this sheet ITS OWN palette of `derive` entries instead of snapping to
   * the game's shared 32.
   *
   * The count includes the pinned ink, so `derive: 20` is the same lock the
   * shared path runs under — 20 slots, spent on one creature. See
   * `palette-derive.ts`. `ban` is meaningless here (a derived palette has no
   * `rot` ramp to wander onto) and is ignored with a note in the verdict.
   */
  derive?: number;
  /**
   * The art is ALREADY at final texel resolution — import it untouched.
   *
   * No scale vote, no resample, no presharpen: each source pixel IS one texel.
   * This is the path for art authored at the size it ships at, which is how the
   * sprites this pipeline is measured against are made. The sheet still gets a
   * palette (shared or derived) because a generator cannot be asked for a fixed
   * colour count — that was measured, twice — but nothing about its GEOMETRY is
   * decided here.
   *
   * ⚠️ IT THROWS RATHER THAN SHRINKING. A native sheet whose figure is larger
   * than the cel budget cannot be scaled down without giving up the one
   * property it was authored for, and silently resampling it would leave the
   * artist reading a report about a path their art did not take.
   */
  native?: boolean;
}

export interface CommitReport {
  factor: number;
  /** Texel height of the tallest LIVING cell — what the player sees. */
  texelH: number;
  /** Texel width of the widest living cell. */
  texelW: number;
  /** Distinct palette entries in the committed sheet. Never above the lock. */
  entries: number;
  /** Entries the lock evicted, remapped to their nearest survivor. */
  evicted: number;
  /** Share of opaque texels whose index CHANGED because of the eviction. */
  evictedShare: number;
  /** Orphan texels the despeckle pass re-coloured to a neighbour. */
  despeckled: number;
  /** One line for the forge report. */
  verdict: string;
}

export interface CommitResult {
  image: RawImage;
  rows: ManifestRow[];
  report: CommitReport;
  /**
   * The palette the sheet's texels actually sit on.
   *
   * Present ALWAYS, not only when derived: the runtime needs to know what to
   * snap this sheet against, and "it is the shared one" is a fact that should
   * be written down rather than assumed by whoever reads the manifest next.
   */
  palette: number[][];
  /** True when `palette` is this sheet's own rather than the game's. */
  derived: boolean;
}

/**
 * Default local-contrast boost before the reduce. See `CommitOptions.presharpen`.
 */
export const DEFAULT_PRESHARPEN = 0.9;

/**
 * Default region floor in texels. See `CommitOptions.minRegion`.
 *
 * Swept 0/3/4/6/9 on the knight (`work/flat-ab/`). Mean region size rises
 * 6.55 → 8.00 → 8.36 → 8.80 → 9.04 texels; the armour plates visibly
 * consolidate through 6 and start losing their edges by 9. The eye survives at
 * every setting, which is the accent gate doing its job.
 */
export const DEFAULT_MIN_REGION = 6;

/**
 * How near a neighbour must be, in the snap's own metric, to absorb a region.
 *
 * Same role and the same order of magnitude as `DESPECKLE_NEAR`, and it is what
 * stops this pass eating the features it is standing next to. Swept on the
 * knight: below ~0.006 nothing merges and the mosaic survives; above ~0.02 the
 * pupil and the eye highlight start being absorbed by the face.
 */
export const REGION_NEAR = 0.012;

/**
 * The metric every commit uses unless its sidecar says otherwise.
 *
 * `oklab` since 2026-08-03. See `colour.ts` for the measurement that moved it
 * off the legacy luma match, and `snap-metric.test.ts` for the arms.
 */
export const DEFAULT_METRIC: SnapMetric = "oklab";

/**
 * The cells that SET the sheet's scale, with the same two fallbacks
 * `aliveScale` uses — locomotion, then everything but death, then everything.
 *
 * Never an empty vote: a sheet that names no locomotion clip (an effect strip,
 * a boss with only `attack` and `death`) still has to be sized, and falling
 * through is how it gets sized by something rather than by nothing.
 */
function pickVote(rows: readonly ManifestRow[], all: readonly Cell[]): readonly Cell[] {
  const locomotion = rows.filter((r) => VOTING_CLIPS.has(r.clip)).flatMap((r) => r.cells);
  if (locomotion.length) return locomotion;
  const alive = rows.filter((r) => r.clip !== "death").flatMap((r) => r.cells);
  return alive.length ? alive : all;
}

/**
 * Unsharp mask on LUMA, radius scaled to the REDUCTION the cell is about to take.
 *
 * The radius has to track the reduce or the pass is meaningless: boosting detail
 * finer than one output texel just adds noise the k-centroid then votes away,
 * and boosting detail much coarser than a texel shades whole limbs. One output
 * texel covers `src.height / th` source rows, so that is the neighbourhood.
 */
function presharpen(src: RawImage, amount: number, th: number): RawImage {
  if (amount <= 0 || th <= 0) return src;
  const rad = Math.max(1, Math.round(src.height / th / 2));
  const { width: w, height: h, data } = src;
  const lum = new Float32Array(w * h);
  for (let p = 0; p < w * h; p++) {
    lum[p] = 0.3 * data[p * 4] + 0.59 * data[p * 4 + 1] + 0.11 * data[p * 4 + 2];
  }
  // Separable box blur, alpha-aware: a transparent neighbour must not drag the
  // rim toward zero, or every silhouette edge grows a bright halo.
  const tmp = new Float32Array(w * h);
  const blur = new Float32Array(w * h);
  const opaque = (p: number): boolean => data[p * 4 + 3] > OPAQUE_CUTOFF;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let k = -rad; k <= rad; k++) {
        const xx = x + k;
        if (xx < 0 || xx >= w) continue;
        const p = y * w + xx;
        if (!opaque(p)) continue;
        s += lum[p]; n++;
      }
      tmp[y * w + x] = n ? s / n : lum[y * w + x];
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let s = 0, n = 0;
      for (let k = -rad; k <= rad; k++) {
        const yy = y + k;
        if (yy < 0 || yy >= h) continue;
        const p = yy * w + x;
        if (!opaque(p)) continue;
        s += tmp[p]; n++;
      }
      blur[y * w + x] = n ? s / n : tmp[y * w + x];
    }
  }
  const out: RawImage = { width: w, height: h, data: new Uint8ClampedArray(data) };
  for (let p = 0; p < w * h; p++) {
    if (!opaque(p)) continue;
    const L = lum[p];
    if (L <= 0.5) continue;
    const boosted = L + amount * (L - blur[p]);
    const k = Math.max(0, boosted) / L;
    out.data[p * 4] = data[p * 4] * k;
    out.data[p * 4 + 1] = data[p * 4 + 1] * k;
    out.data[p * 4 + 2] = data[p * 4 + 2] * k;
  }
  return out;
}

/** Copy one cell's rect out of the sheet into its own buffer. */
function cutCell(src: RawImage, cell: Cell): RawImage {
  const [x0, y0, x1, y1] = cell;
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const out: RawImage = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  for (let y = 0; y < h; y++) {
    const s = ((y0 + y) * src.width + x0) * 4;
    out.data.set(src.data.subarray(s, s + w * 4), y * w * 4);
  }
  return out;
}

/**
 * Reduce, snap, evict and re-up a whole sheet onto one lattice.
 *
 * `rows` carries the clip names because the LIVING clips set the scale and a
 * death sprawl only clamps itself — the same rule as `aliveScale`, and for the
 * same reason: letting a flat sprawl vote shrinks the walking creature.
 */
/**
 * Did the layout put every declared cell in its own column band?
 *
 * ── WHY THIS IS NOT "the re-slice returns the declared counts" ─────────────
 *
 * It used to be, and that test is subtly wrong: it assumes a declared cell is
 * ONE connected blob. Plenty of real poses are not. The knight's spin attack
 * opens with the body and a swung element clear of it — two blobs inside one
 * frame — and every facing of his sheet declares that frame as one cell, which
 * is correct, because it IS one frame. `sliceSheet` counts blobs, so it will
 * always report one more cell than declared for that row, at EVERY gutter. The
 * loop therefore exhausted its range and threw on art that was fine.
 *
 * It threw for three sheets, the run aborted before publishing two facings, and
 * the repair was to hand-copy sidecars into `public/sprites/` — which the loader
 * reads as `undefined` and silently drops to the painter. A check that cannot
 * pass is worse than no check, because someone will route around it.
 *
 * What the gutter actually has to guarantee is SEPARATION: no two cells the
 * layout placed may bleed into one another, and no row may vanish. So that is
 * what gets asserted — every sliced blob nests inside exactly one placed cell,
 * and every placed cell contains at least one blob. A pose made of two pieces
 * passes. Two figures merged by too tight a gutter still fails, which is the
 * defect this loop exists to prevent.
 */
function separated(placed: readonly ManifestRow[], got: readonly { cells: Cell[] }[]): boolean {
  if (got.length !== placed.length) return false;
  for (let ri = 0; ri < placed.length; ri++) {
    const cells = placed[ri].cells;
    const blobs = got[ri].cells;
    // Every blob must sit inside one placed cell. A blob straddling two means
    // they merged — exactly the failure a wider gutter fixes.
    const hits = new Array<number>(cells.length).fill(0);
    for (const [bx0, , bx1] of blobs) {
      const owner = cells.findIndex(([cx0, , cx1]) => bx0 >= cx0 && bx1 <= cx1);
      if (owner < 0) return false;
      hits[owner]++;
    }
    // And every placed cell must have been found. A cell with no blob was
    // erased — the caption filter, or a frame that is genuinely empty.
    if (hits.some((n) => n === 0)) return false;
  }
  return true;
}

export function commitToGrid(
  src: RawImage,
  rows: readonly ManifestRow[],
  pal: readonly (readonly number[])[],
  opts: CommitOptions = {},
): CommitResult {
  const factor = opts.factor ?? DEFAULT_FACTOR;
  const fitGrid = opts.fitGrid ?? FIT_GRID;
  const maxEntries = opts.maxEntries ?? MAX_ENTRIES;
  const gutter = Math.max(1, opts.gutter ?? 1);
  const metric: SnapMetric = opts.metric ?? DEFAULT_METRIC;
  const mode = opts.mode ?? "vote";
  const native = opts.native ?? false;
  // Neither pass has anything to sharpen FOR. `presharpen` exists to give the
  // k-centroid a decisive vote to count; `synth` counts region labels and
  // `native` counts nothing at all, so the pass would only add halos.
  const preAmt = native || mode === "synth" ? 0 : opts.presharpen ?? DEFAULT_PRESHARPEN;
  const minRegion = opts.minRegion ?? DEFAULT_MIN_REGION;

  const all: Cell[] = rows.flatMap((r) => r.cells);
  if (!all.length) throw new Error("[commit] no cells");

  // ── 1. TEXEL SIZE ────────────────────────────────────────────────────────
  //
  // The LOCOMOTION clips vote. `ART_FIT_*` are art units out of `ART_BOX`, so
  // the texel budget at this rung is that fraction of the grid.
  //
  // ⚠️ THIS WAS "EVERYTHING BUT DEATH", AND THAT IS THE EXACT RULE
  // `aliveScale` WAS REWRITTEN TO STOP USING — see VOTING_CLIPS in manifest.ts,
  // where a list of exclusions is documented as growing silently while a list
  // of voters does not. The runtime learned it; the commit kept the old rule
  // and repeated the defect on the OTHER AXIS.
  //
  // Measured on the knight, whose three facings are three sheets committed
  // independently. `s` is `min(fitW/maxW, fitH/maxH)`, so the widest voting
  // cell can bind instead of the tallest — and the E sheet's attack frames
  // swing a sword through a 244px arc:
  //
  //     facing   widest voter   binds on   idle height
  //       S        ~51 texels    HEIGHT      69
  //       N        ~53 texels    HEIGHT      69
  //       E      69 (the swing)  WIDTH       61   <- 11% shorter
  //
  // The knight SHRANK every time he turned to walk sideways, which is the one
  // facing the E sheet was added for. With only idle/walk/run voting, E's
  // widest voter is ~44 texels, height binds on all three sheets, and the swing
  // clamps its own frames in `sized` below exactly as a death sprawl does.
  // ── NATIVE: THE ART ALREADY DECIDED ITS OWN SIZE ─────────────────────────
  //
  // Every line below this point about voting, fitting and clamping exists to
  // answer "how many texels should this figure be", and a sheet authored at
  // final resolution has already answered it. So the whole block is skipped and
  // the answer is checked instead: if the figure does not fit the cel, the art
  // is wrong and it says so. See `CommitOptions.native`.
  //
  // ⚠️ `death` IS MEASURED AGAINST THE HARD BOX, like everywhere else. The
  // runtime's 1:1 gate (`fitsArtBox` in `importedPaints`) excludes death cells,
  // and a sprawl is genuinely wider than a standing pose — holding it to the
  // alive box rejected a sheet the game would have imported perfectly. Caught
  // by the bench on the first native run: a 71-texel sprawl against a 70-texel
  // alive cap, on art whose living frames were nowhere near either limit.
  if (native) {
    const aliveCells = rows.filter((r) => r.clip !== "death").flatMap((r) => r.cells);
    const deathCells = rows.filter((r) => r.clip === "death").flatMap((r) => r.cells);
    const check = (cells: readonly Cell[], capW: number, capH: number, what: string): void => {
      if (!cells.length) return;
      const nw = Math.max(...cells.map(([x0, , x1]) => x1 - x0 + 1));
      const nh = Math.max(...cells.map(([, y0, , y1]) => y1 - y0 + 1));
      if (nw <= capW && nh <= capH) return;
      throw new Error(
        `[commit] native sheet's ${what} cells are ${nw}×${nh} texels but the budget at atlas grid ` +
          `${fitGrid} is ${capW}×${capH}. Native art is imported 1:1 or not at all — re-author it ` +
          `smaller rather than letting the forge resample the one property it was authored for.`,
      );
    };
    check(aliveCells.length ? aliveCells : all, Math.floor((ART_FIT_W * fitGrid) / ART_BOX), Math.floor((ART_FIT_H * fitGrid) / ART_BOX), "living");
    check(deathCells, fitGrid, Math.floor((ART_GROUND * fitGrid) / ART_BOX), "death");
  }

  const vote = pickVote(rows, all);
  // FLOORED, because the budget is spent in whole texels. At grid 72 the raw
  // budget is 61.875 and the tallest cell's `Math.round` below would land on
  // 62 — overflowing the very rung this sizes for. (At the retired grid 54 the
  // fraction happened to round down, which is why this never fired before.)
  const fitW = Math.floor((ART_FIT_W * fitGrid) / ART_BOX);
  const fitH = Math.floor((ART_FIT_H * fitGrid) / ART_BOX);
  const maxW = Math.max(...vote.map(([x0, , x1]) => x1 - x0 + 1));
  const maxH = Math.max(...vote.map(([, y0, , y1]) => y1 - y0 + 1));
  /** Committed texels per source pixel. */
  const s = Math.min(fitW / maxW, fitH / maxH);

  // ── THE CLAMP, AND WHOSE BOX EACH CELL IS CLAMPED TO ─────────────────────
  //
  // A death cell may genuinely be wider than the living box; it clamps to the
  // HARD cel limits alone, exactly as `cellScale` does at runtime.
  //
  // ⚠️ EVERY OTHER NON-VOTING CLIP CLAMPS TO `fit`, NOT TO `hard`, BECAUSE THE
  // RUNTIME'S 1:1 GATE IS THE STRICTER OF THE TWO. `importedPaints` decides
  // whether a committed sheet imports 1:1 by running `fitsArtBox` over the
  // cells it calls ALIVE — everything but `death` — against `ART_FIT_*`. The
  // hard limits (`ART_BOX`, `ART_GROUND`) are looser, so a clamped attack frame
  // could sit inside the commit's box and outside the gate's, and the whole
  // sheet silently dropped to the fitted resample it was committed to avoid.
  //
  // Measured the moment locomotion-only voting let the knight's E swing clamp
  // instead of vote: the sword arc landed at 80×76 texels, `fitsArtBox` read
  // 121.9 wide against 108 and 115.8 tall against 110, and the E facing went
  // soft at the default rung — trading the shrink-on-turn for a blur. Clamping
  // alive cells to `fit` costs that one swing about 8% of its reach and keeps
  // the property every other frame depends on.
  const hardW = fitGrid;
  const hardH = (ART_GROUND * fitGrid) / ART_BOX;
  const clip = rows.flatMap((r) => r.cells.map(() => r.clip));
  const sized: [number, number][] = all.map((c, i): [number, number] => {
    const w = c[2] - c[0] + 1;
    const h = c[3] - c[1] + 1;
    if (native) return [w, h];
    // `death` is excluded from the runtime gate, so it alone keeps the hard box.
    const [capW, capH] = clip[i] === "death" ? [hardW, hardH] : [fitW, fitH];
    const k = Math.min(s, capW / w, capH / h);
    // Rounding can push a cell one texel past a floored cap; the cap wins.
    return [
      Math.max(1, Math.min(Math.round(capW), Math.round(w * k))),
      Math.max(1, Math.min(Math.round(capH), Math.round(h * k))),
    ];
  });

  // ── 2. REDUCE, then SNAP ─────────────────────────────────────────────────
  //
  // k-centroid rather than a box average: an average of a soft edge invents a
  // colour in neither side, and the snap downstream then has to guess which was
  // meant. See `resample.ts`.
  const texels = all.map((c, i) => {
    const cut = cutCell(src, c);
    // Native art is already texels — the "reduce" is the identity, and running
    // a 1:1 k-centroid over it would still round-trip every pixel through a
    // vote it cannot lose but can tie.
    if (native) return cut;
    if (mode === "synth") return synthCell(cut, sized[i][0], sized[i][1], opts.synth);
    return resampleCell(presharpen(cut, preAmt, sized[i][1]), sized[i][0], sized[i][1], "kcentroid");
  });

  // ── 2a. THE PALETTE — the game's, or this creature's ──────────────────────
  //
  // Derived AFTER the reduce, deliberately: the thing being coloured is the
  // reduced figure, and a three-pixel specular the reduce is about to average
  // away must not win one of twenty slots. See `palette-derive.ts`.
  const derived = (opts.derive ?? 0) > 0;
  const derivedPal = derived ? derivePalette(texels, Math.min(opts.derive!, maxEntries)) : null;
  const effPal: readonly (readonly number[])[] = derivedPal ? derivedPal.rgb : pal;

  // ⚠️ THE BAN IS APPLIED BY NOT OFFERING THE ENTRY, not by remapping after.
  //
  // It used to snap against the whole palette and then hop each banned index to
  // its nearest allowed neighbour. Two hops through a lossy metric compound its
  // error — and worse, the hop was computed between two PALETTE entries, so the
  // colour that actually got measured (the texel) never entered into it. A
  // warm-grey texel that landed on rot-mid was then moved to whatever sat
  // nearest rot-mid, which is not the same question as what sits nearest the
  // texel. Snapping to the allowed set answers the right question once.
  //
  // A DERIVED palette cannot be banned and does not need to be: `ban` names a
  // FAMILY of the shared palette ("this creature owns no rot"), and a palette
  // clustered out of the creature's own texels has no family to disown. The
  // option is dropped rather than half-honoured, and the verdict says so.
  const banned = new Set(derived ? [] : opts.ban ?? []);
  const allowed = new Set(effPal.map((_, i) => i).filter((i) => !banned.has(i)));
  if (!allowed.size) throw new Error("[commit] ban covers the whole palette");
  const snapper = makeSnapper(effPal, metric, allowed);

  const counts = new Map<number, number>();
  const idx: Int16Array[] = [];
  for (const t of texels) {
    const m = new Int16Array(t.width * t.height).fill(-1);
    for (let p = 0; p < m.length; p++) {
      if (t.data[p * 4 + 3] <= OPAQUE_CUTOFF) continue;
      const r = snapper.snap(t.data[p * 4], t.data[p * 4 + 1], t.data[p * 4 + 2]);
      m[p] = r;
      counts.set(r, (counts.get(r) ?? 0) + 1);
    }
    idx.push(m);
  }

  // ── 3. EVICT to the lock ─────────────────────────────────────────────────
  //
  // Keep the entries with the most COVERAGE and remap the rest to their nearest
  // survivor under the snap's own metric. Coverage, not spread: a colour holding
  // 4% of the sprite is load-bearing and one holding 0.01% is a resample
  // artifact wearing a palette index. This is the step that makes `entries`
  // satisfy the lock BY CONSTRUCTION instead of by hoping — the crush would
  // otherwise evict for us, at load, picking by a rule the artist never sees.
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const keep = ranked.slice(0, maxEntries).map(([i]) => i);
  const drop = ranked.slice(maxEntries).map(([i]) => i);
  const remap = new Map<number, number>();
  for (const d of drop) {
    let best = keep[0];
    let bd = Infinity;
    for (const k of keep) {
      const dist = snapper.dist(d, k);
      if (dist < bd) {
        bd = dist;
        best = k;
      }
    }
    remap.set(d, best);
  }
  let moved = 0;
  let opaque = 0;
  for (const m of idx) {
    for (let p = 0; p < m.length; p++) {
      if (m[p] < 0) continue;
      opaque++;
      const r = remap.get(m[p]);
      if (r !== undefined) {
        m[p] = r;
        moved++;
      }
    }
  }

  // ── 3a. DESPECKLE — orphan texels adopt a neighbour ──────────────────────
  //
  // After the snap and the evict, a texel whose index differs from ALL FOUR
  // orthogonal opaque neighbours is nearly always a resample artifact — the
  // census counts exactly these as `isolated%`, and the pixel-art rule it
  // encodes ("orphan pixels read as noise") is the one practitioners apply by
  // hand. One pass, read-from-snapshot so order cannot matter: each orphan
  // adopts the neighbouring colour CHROMATICALLY NEAREST to its own, and only
  // if that colour is genuinely close (the gate below). The gate is the accent
  // protection, measured in pixel-trace (`DESPECKLE_NEAR`): a white glint on
  // dark armor is far from every neighbour and survives; a mauve fringe pixel
  // beside brown leather is near it and dies. Ported from
  // `pixel-trace/trace.mjs`, where it caught ~67% of fringe texels against
  // 2.6% for a plurality filter.
  //
  // `palDist` is luma-weighted (weights .3/.59/.11, squared), so 1600 here
  // corresponds to the plain-RGB 60² gate pixel-trace measured with.
  const DESPECKLE_NEAR = 1600;
  let despeckled = 0;
  if (!opts.noDespeckle) {
    for (let ci = 0; ci < idx.length; ci++) {
      const [w, h] = sized[ci];
      const before = idx[ci].slice();
      const m = idx[ci];
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const q = before[y * w + x];
          if (q < 0) continue;
          let bestN = -1;
          let bd = Infinity;
          let alone = true;
          for (const [dx2, dy2] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            const nx = x + dx2, ny = y + dy2;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const nq = before[ny * w + nx];
            if (nq < 0) continue;
            if (nq === q) { alone = false; break; }
            const d = snapper.dist(q, nq);
            if (d < bd) { bd = d; bestN = nq; }
          }
          if (!alone || bestN < 0 || bd > DESPECKLE_NEAR) continue;
          m[y * w + x] = bestN;
          despeckled++;
        }
      }
    }
  }

  // ── 3a-bis. FLATTEN — small REGIONS join the neighbour they touch most ───
  //
  // See `CommitOptions.minRegion`. Connected components of one palette index,
  // 4-connected; anything under the floor is absorbed by the bordering index it
  // shares the most edge with, provided that index is chromatically near
  // (`REGION_NEAR`) so accents and pupils survive. Repeated until stable,
  // because absorbing a patch can leave its neighbour still under the floor.
  let flattened = 0;
  if (minRegion > 1) {
    for (let ci = 0; ci < idx.length; ci++) {
      const [w, h] = sized[ci];
      const m = idx[ci];
      for (let pass = 0; pass < 4; pass++) {
        const comp = new Int32Array(w * h).fill(-1);
        const members: number[][] = [];
        let moved = 0;
        for (let p = 0; p < m.length; p++) {
          if (m[p] < 0 || comp[p] >= 0) continue;
          const id = members.length;
          const cells: number[] = [];
          const stack = [p];
          comp[p] = id;
          while (stack.length) {
            const q = stack.pop()!;
            cells.push(q);
            const qx = q % w, qy = (q / w) | 0;
            for (const [dx2, dy2] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
              const nx = qx + dx2, ny = qy + dy2;
              if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
              const n = ny * w + nx;
              if (comp[n] >= 0 || m[n] !== m[q]) continue;
              comp[n] = id;
              stack.push(n);
            }
          }
          members.push(cells);
        }
        for (const cells of members) {
          if (cells.length >= minRegion) continue;
          const mine = m[cells[0]];
          // Border length per neighbouring index.
          const border = new Map<number, number>();
          for (const q of cells) {
            const qx = q % w, qy = (q / w) | 0;
            for (const [dx2, dy2] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
              const nx = qx + dx2, ny = qy + dy2;
              if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
              const nq = m[ny * w + nx];
              if (nq < 0 || nq === mine) continue;
              border.set(nq, (border.get(nq) ?? 0) + 1);
            }
          }
          let best = -1, bestLen = 0, bestD = Infinity;
          for (const [nq, len] of border) {
            const d = snapper.dist(mine, nq);
            if (d > REGION_NEAR) continue;
            if (len > bestLen || (len === bestLen && d < bestD)) { best = nq; bestLen = len; bestD = d; }
          }
          if (best < 0) continue;
          for (const q of cells) m[q] = best;
          moved += cells.length;
        }
        flattened += moved;
        if (!moved) break;
      }
    }
  }

  // ── 3c. THE AUTHORED OUTLINE, when asked for ─────────────────────────────
  //
  // Read from a SNAPSHOT of which texels are opaque, so an inked texel does not
  // make its neighbour an edge texel too — that is the difference between an
  // outline and a creature losing two texels of silhouette on every limb.
  //
  // The ink entry is found by asking the snapper, not by hardcoding index 1:
  // on a derived palette ink sits at 0, on the shared palette at 1, and a
  // constant here would silently paint the wrong colour on one of the two.
  if (opts.outline) {
    const inkIdx = snapper.snap(INK_RGB[0], INK_RGB[1], INK_RGB[2]);
    for (let ci = 0; ci < idx.length; ci++) {
      const [w, h] = sized[ci];
      const m = idx[ci];
      const solid = new Uint8Array(w * h);
      for (let p = 0; p < m.length; p++) solid[p] = m[p] >= 0 ? 1 : 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const p = y * w + x;
          if (!solid[p]) continue;
          const edge =
            x === 0 || y === 0 || x === w - 1 || y === h - 1 ||
            !solid[p - 1] || !solid[p + 1] || !solid[p - w] || !solid[p + w];
          if (edge) m[p] = inkIdx;
        }
      }
    }
  }

  // ── 3b. TRIM EACH CELL TO ITS INK ────────────────────────────────────────
  //
  // ⚠️ THE COMMITTED CELL MUST BE A WHOLE NUMBER OF BLOCKS WIDE AND TALL, and a
  // rect with transparent margin is not. Nothing downstream reads the rects
  // written here: the forge and the game both RE-SLICE the sheet, and the
  // slicer trims to the opaque bounding box. So a cell padded out to its
  // resample rect came back 183 px wide against a ×8 lattice — 22.875 blocks —
  // and the 1:1 reduce silently degraded to a 3.98:1 fractional resample that
  // invented colours all over again. Measured: 25.7 entries where the source
  // held 20. Trimming here is what makes the slicer's answer land on the
  // lattice, and it must happen BEFORE the layout uses the sizes.
  const trimmed = idx.map((m, i) => {
    const [w, h] = sized[i];
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (m[y * w + x] < 0) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    if (x1 < 0) return { w: 1, h: 1, m: new Int16Array(1).fill(-1) }; // empty cell
    const tw = x1 - x0 + 1;
    const th = y1 - y0 + 1;
    const t = new Int16Array(tw * th);
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) t[y * tw + x] = m[(y0 + y) * w + x0 + x];
    return { w: tw, h: th, m: t };
  });
  trimmed.forEach((t, i) => { sized[i] = [t.w, t.h]; idx[i] = t.m; });

  // ── 4. RE-UP onto ONE lattice ────────────────────────────────────────────
  //
  // Cell origins are multiples of `factor`, so every colour change in every
  // cell lands on the same lattice lines. `grid.ts` scores PHASE over absolute
  // sheet coordinates — cells that each gridded to their own origin would score
  // as no lattice at all, which is the trap this loop exists to avoid.
  /** Index into `sized`/`idx` of each row's first cell. */
  const rowStart: number[] = [];
  for (let ri = 0, o = 0; ri < rows.length; o += rows[ri].cells.length, ri++) rowStart.push(o);
  const rowSized = (ri: number): [number, number][] =>
    rows[ri].cells.map((_, i) => sized[rowStart[ri] + i]);

  const rowH = rows.map((_, ri) => Math.max(...rowSized(ri).map(([, h]) => h)));

  /**
   * Upper bound on the ink in any one scanline: a row's cells all at full width.
   *
   * `slice.ts` measures its ruled-line test against the SHEET width, so the
   * sheet is padded until even that worst case stays under the threshold. This
   * is what rescues a row holding ONE very wide cell (a death sprawl), which no
   * gutter can help — a lone cell spans its row whatever sits beside it.
   */
  const inkW = Math.max(...rows.map((_, ri) => rowSized(ri).reduce((a, [w]) => a + w, 0)));
  /** Below `RULE_FILL`, with margin for the threshold moving. */
  const COVER = 0.62;

  const layout = (g: number): { image: RawImage; rows: ManifestRow[] } => {
    const rowW = rows.map((_, ri) => rowSized(ri).reduce((a, [w]) => a + w + g, g));
    const W = Math.max(Math.max(...rowW), Math.ceil(inkW / COVER)) * factor;
    const H = rowH.reduce((a, h) => a + h + g, g) * factor;
    const image: RawImage = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) };
    const outRows: ManifestRow[] = [];
    let ty = g;
    let n = 0;
    for (let ri = 0; ri < rows.length; ri++) {
      let tx = g;
      const cellsOut: Cell[] = [];
      for (let ci = 0; ci < rows[ri].cells.length; ci++, n++) {
        const [tw, th] = sized[n];
        const m = idx[n];
        // Feet on the row's baseline, so a crouched pose does not float.
        const oy = ty + (rowH[ri] - th);
        for (let y = 0; y < th; y++) {
          for (let x = 0; x < tw; x++) {
            const q = m[y * tw + x];
            if (q < 0) continue;
            const [r, gg, b] = effPal[q];
            for (let by = 0; by < factor; by++) {
              let o = (((oy + y) * factor + by) * W + (tx + x) * factor) * 4;
              for (let bx = 0; bx < factor; bx++, o += 4) {
                image.data[o] = r;
                image.data[o + 1] = gg;
                image.data[o + 2] = b;
                image.data[o + 3] = 255;
              }
            }
          }
        }
        cellsOut.push([tx * factor, oy * factor, (tx + tw) * factor - 1, (oy + th) * factor - 1]);
        tx += tw + g;
      }
      outRows.push({ clip: rows[ri].clip, cells: cellsOut });
      ty += rowH[ri] + g;
    }
    return { image, rows: outRows };
  };

  // ── 5. WIDEN THE GUTTER UNTIL THE PLACED CELLS ARE SEPARATED ─────────────
  //
  // ⚠️ NOTHING READS THE RECTS RETURNED HERE. The forge and the game both
  // re-slice the committed PNG, so the only rects that matter are the ones
  // `sliceSheet` will find — and a tightly packed sheet defeats it. `slice.ts`
  // erases any row whose ink spans ≥70% of the sheet width as a RULED LINE, and
  // eight trimmed figures at a 1-texel gutter do exactly that across their
  // ruffs: measured, the 2-row committed jester re-sliced as FOUR rows and the
  // run aborted on the sidecar mismatch.
  //
  // A constant gutter cannot fix this — the coverage depends on the figure
  // count and the silhouette — so the commit checks its own work instead:
  // lay out, re-slice, and widen until the answer agrees. Verifying beats
  // tuning, because the threshold belongs to `slice.ts` and may move.
  const want = rows.map((r) => r.cells.length);
  let built: { image: RawImage; rows: ManifestRow[] } | null = null;
  const tried: number[] = [];
  let lastGot: number[] = [];
  for (let g = gutter; g <= gutter + Math.max(8, Math.ceil(Math.max(...sized.map(([w]) => w)))); g++) {
    const cand = layout(g);
    const got = sliceSheet(cand.image.data, cand.image.width, cand.image.height);
    tried.push(g);
    lastGot = got.map((r) => r.cells.length);
    if (separated(cand.rows, got)) {
      built = cand;
      break;
    }
  }
  // A capped loop that gives up quietly would hand back a sheet the pipeline
  // rejects three steps later, with nothing pointing here. Fail loudly instead.
  if (!built) {
    throw new Error(
      `[commit] laid out ${want.length} rows [${want.join("/")}] but no gutter in ` +
        `${tried[0]}..${tried[tried.length - 1]} SEPARATES them — at the widest gutter the ` +
        `re-slice still found [${lastGot.join("/")}]. Fewer cells than declared means figures ` +
        `are TOUCHING; fewer ROWS means a band was dropped, most likely by slice.ts's caption ` +
        `filter (a band under CAPTION_RATIO 25% of the median height). Row texel heights: ` +
        `[${rowH.join("/")}].`,
    );
  }
  const out = built.image;
  const outRows = built.rows;

  const entries = new Set<number>();
  for (const m of idx) for (const q of m) if (q >= 0) entries.add(q);

  const aliveSized = rows.flatMap((r, ri) => (r.clip === "death" ? [] : rowSized(ri)));
  const useSized = aliveSized.length ? aliveSized : sized;
  const texelH = Math.max(...useSized.map(([, h]) => h));
  const texelW = Math.max(...useSized.map(([w]) => w));
  const evictedShare = opaque ? moved / opaque : 0;

  return {
    image: out,
    rows: outRows,
    palette: effPal.map((c) => [...c]),
    derived,
    report: {
      factor,
      texelH,
      texelW,
      entries: entries.size,
      evicted: drop.length,
      evictedShare,
      despeckled,
      verdict:
        `COMMITTED ×${factor}${native ? " NATIVE" : mode === "synth" ? " SYNTH" : ""} — figure ` +
        `${texelW}×${texelH} texels, ${entries.size} palette entries` +
        (drop.length
          ? ` (${drop.length} evicted to meet the ${maxEntries} lock, ${(evictedShare * 100).toFixed(2)}% of opaque texels moved)`
          : ` (under the ${maxEntries} lock with room to spare)`) +
        (despeckled ? ` [despeckled ${despeckled}]` : "") +
        (flattened ? ` [flattened ${flattened} texel(s) of sub-${minRegion} regions]` : "") +
        (banned.size ? ` [banned entries: ${[...banned].sort((a, b) => a - b).join(",")}]` : "") +
        (derived
          ? ` [PER-SPRITE palette, ${effPal.length} entries derived from the sheet]`
          : ` [shared Cold-Crypt palette]`) +
        (derived && opts.ban?.length ? ` [ban ignored — a derived palette has no families]` : "") +
        ` [snap: ${metric}]` +
        // Name the rungs rather than claiming all five. The claim was true only
        // while `FIT_GRID` was the WIDEST rung; sizing for the DEFAULT trades
        // the two widest rungs for 20% more figure everywhere else, and a
        // verdict line that overstates the guarantee is how the trade would get
        // silently reverted by whoever reads it next.
        `. Imports 1:1 at atlas grid ≥ ${fitGrid}` +
        (fitGrid > 72 ? `; wider rungs take the fitted resample.` : ` — every camera rung.`),
    },
  };
}
