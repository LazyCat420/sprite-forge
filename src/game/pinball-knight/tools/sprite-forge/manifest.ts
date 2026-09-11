/**
 * THE HANDOFF between the forge and the game.
 *
 * The forge does the work that is deterministic and expensive — keying the
 * background, finding the cells — and writes the result next to a MATTED copy
 * of the sheet. The game does the work that depends on the player's settings:
 * scaling each cell into the painters' art box and crushing it to whatever
 * atlas grid the live camera rung implies.
 *
 * ── WHY THE GAME IS NOT HANDED FINISHED FRAMES ──────────────────────────────
 *
 * Because there is no such thing as a finished frame here. `SPRITE_PIXEL_GRID`
 * is `PPU * 3/2` and `CAMERA_ZOOMS` runs {close 80, normal 72, wide 64, wider
 * 56, widest 48}, so the atlas cell is 120, 108, 96, 84 or 72 texels depending
 * on a setting resolved from localStorage at module load. A baked 84px atlas is
 * wrong at four of the five, and rescaling pixel art by 84/120 destroys it.
 *
 * So the shipped artifact is the SOURCE at full resolution, and the crush
 * happens at runtime — which is exactly what a painter does. An imported frame
 * enters through the same door as a painted one (`FramePaint`), so palette
 * locking, `withRecoil`, cross-facing dedupe and atlas packing all apply to it
 * without knowing it came from an image.
 */
import type { Cell } from "./slice";

/** A row of the source sheet, and the clip it plays as. */
export interface ManifestRow {
  /** A `ClipName` when the sidecar named one, else `row0`, `row1`, … */
  clip: string;
  cells: Cell[];
}

export interface SheetManifest {
  /** Creature id — matches the `SheetKey` it reskins. */
  name: string;
  /** The facing this sheet authors. Only `S`, `N` and `E` are ever authored. */
  dir: "S" | "N" | "E";
  /** Path under `public/`, e.g. `/sprites/jester-S.png`. Already matted. */
  image: string;
  /** Source pixel dimensions, so a mismatched re-export is caught on load. */
  source: [number, number];
  /**
   * Content tag for the PNG, used as its cache-busting URL version.
   *
   * The sidecar is served `no-store` and the image `max-age=86400,
   * stale-while-revalidate=604800`, so without a versioned URL a returning
   * browser pairs a fresh manifest with a week-old image. See `versioned()` in
   * render/imported-paints.ts for the production failure this comes from.
   *
   * Optional: sheets published before this fall back to their dimensions, which
   * catches every resize. Write it when you can — it also catches a re-export at
   * the SAME size, which dimensions cannot.
   */
  hash?: string;
  /**
   * The source's intrinsic block size, from `grid.ts`. 1 = no lattice (the art
   * is continuous and must be RESAMPLED). Greater than 1 means every N×N block
   * is one authored pixel, which is what makes a 1:1 import possible at all.
   */
  grid?: number;
  /** Optional scale multiplier for rendering sizing standardization. */
  scale?: number;
  /**
   * Draw every cell horizontally FLIPPED: the source art faces the opposite of
   * `dir`. `dir` is a screen promise (`E` = seen walking right); a generated
   * "side profile" sheet picks its own side, and relabelling or repainting the
   * PNG would break the sidecar's declared rects. Carried from the sidecar by
   * the publish run; honoured in `render/imported-paints.ts`. Note the engine
   * additionally derives W as E-mirrored at draw time, so a mirrored E sheet
   * still yields a correct W.
   */
  mirror?: boolean;
  /**
   * THIS SHEET'S OWN PALETTE — `#rrggbb`, in the order the commit derived it.
   *
   * Present only when the sheet was committed with `derive`, and then it is the
   * complete list of colours its texels sit on. The runtime APPENDS these to
   * the shared palette for this actor's atlas (`SheetBuildOptions.sheetPalette`)
   * rather than replacing it — see that field for why an actor's atlas is not
   * necessarily all imported.
   *
   * Absent means the sheet is on the shared Cold-Crypt palette, which is what
   * every sheet before 2026-08-04 is.
   */
  palette?: string[];
  rows: ManifestRow[];
}

/** The painters' cel box. Mirrors `ART_PX` — see `constants/render.ts`. */
export const ART_BOX = 128;
/** Feet line and horizontal centre inside that box. Mirrors `figure.ts`. */
export const ART_GROUND = 118;
/** The box an imported figure may fill. Mirrors `register.ts`. */
export const ART_FIT_W = 108;
export const ART_FIT_H = 110;

/**
 * ONE uniform scale for the whole sheet, in ART UNITS.
 *
 * Deliberately not per-cell: scaling every frame to its own extent makes the
 * flipbook pulse, because a crouched pose would inflate to a standing one's
 * height. The sheet's most extreme frame sets the scale and every other frame
 * pays for it — which is why an extended spring or a projectile still attached
 * to the actor costs the whole creature size.
 */
export function artScale(cells: readonly Cell[]): number {
  if (!cells.length) return 1;
  const widths = cells.map(([x0, , x1]) => x1 - x0 + 1);
  const heights = cells.map(([, y0, , y1]) => y1 - y0 + 1);
  const maxH = Math.max(...heights);
  const maxW = Math.max(...widths);

  // Standardize monster sizing by height (ART_FIT_H / maxH) so wide frames don't shrink monsters into tiny figures
  const scaleByHeight = ART_FIT_H / maxH;
  // Allow wide frames up to 92% of the ART_BOX (128) width boundary before constraining
  const maxWidthScale = (ART_BOX * 0.92) / maxW;

  return Math.min(scaleByHeight, maxWidthScale);
}

/**
 * The clips that define a creature's RESTING FOOTPRINT, and therefore vote.
 *
 * These are what the player looks at almost all the time, and they are the
 * poses whose size IS the creature's size. Everything else — a lunge, a
 * stagger, a sprawl — is a transient that already clamps itself in `cellScale`.
 */
export const VOTING_CLIPS: ReadonlySet<string> = new Set(["idle", "walk", "run"]);

/**
 * The scale the LOCOMOTION clips set. Every other clip clamps itself.
 *
 * ── WHY THIS IS NOT JUST "EXCLUDE DEATH" ANYMORE ────────────────────────────
 *
 * It was, and the death exclusion was written for a real failure: `artScale`
 * over every cell let the jester's flat death sprawl (385px wide against a
 * 227px standing height) set the scale for the whole sheet, and the walking
 * jester rendered at 64 of its 110 available art units.
 *
 * The same defect survived in the ATTACK clip and nobody had measured it. The
 * jester's spring extends to 216px against a 177px idle, so one transient frame
 * was scaling all twenty — and the frames the player actually watches paid for
 * it. Measured across both imported sheets:
 *
 *     jester   idle 44.4 → 52.4 texels  (+18.0%),  +33% opaque texels
 *     beaver   idle 43.0 → 48.9 texels  (+13.6%)
 *
 * ── THE COST, MEASURED RATHER THAN FEARED ───────────────────────────────────
 *
 * A non-voting clip now clamps, so the creature's own scale can change between
 * clips — the "flipbook pulse" this function's header has always warned about.
 * Worst case is the jester's attack at 9.1%, which sounds alarming and is
 * **0.7 texels** of head-size change (the head is 26 cel units; 7.69 texels at
 * the idle scale, 6.99 at the clamped attack scale), on a frame that plays
 * during a fast spring launch. Bounded, sub-texel, and worth +33% ink.
 *
 * Note this codebase already accepted exactly this trade for `death`; the
 * change is that the rule is now stated positively — locomotion votes — rather
 * than as a growing list of exclusions nobody re-measures.
 *
 * ── THE REAL FIX IS UPSTREAM, IN THE ART ────────────────────────────────────
 *
 * A sheet whose living frames are all within ~8% of one height needs none of
 * this: every clip votes, nothing clamps, the pulse is exactly zero and the
 * figure is as big as the cel allows. That is what `PROMPTS.md` now asks for —
 * stand at full height and animate DOWNWARD, so the wind-up crouches instead of
 * the release punching above the envelope.
 *
 * Rows with no sidecar name (`row0`, …) cannot be classified, so they all vote
 * — with no clip names there is no way to know which row is the transient, and
 * the old behaviour is the only honest fallback.
 */
export function aliveScale(rows: readonly ManifestRow[]): number {
  const voting = rows.filter((r) => VOTING_CLIPS.has(r.clip)).flatMap((r) => r.cells);
  if (voting.length) return artScale(voting);
  // No locomotion clip was named. Fall back to the previous rule (everything
  // but death), then to everything — never to an empty vote.
  const alive = rows.filter((r) => r.clip !== "death").flatMap((r) => r.cells);
  return artScale(alive.length ? alive : rows.flatMap((r) => r.cells));
}

/**
 * Per-cell clamp for the frames the alive scale no longer accounts for.
 *
 * A death cell drawn at the alive scale may genuinely not fit — the sprawl is
 * wider than the box. It is clamped to the HARD cel limits (the full 128 and
 * the ground line), not the alive fit margin: a body collapsing to the floor
 * reads as foreshortening, and only the frames that actually overflow pay.
 * Alive cells never hit this clamp — the alive scale was derived from their
 * own maxima.
 */
export function cellScale(cell: Cell, k: number): number {
  const [x0, y0, x1, y1] = cell;
  return Math.min(k, ART_BOX / (x1 - x0 + 1), ART_GROUND / (y1 - y0 + 1));
}

/**
 * Where one cell lands in the art box: centred on its own ink, feet on GROUND.
 *
 * ⚠️ REGISTRATION IS BY BOUNDING BOX. Correct for a grounded pose, wrong in two
 * ways the art has to avoid: debris below the feet lifts the character off the
 * floor, and an asymmetric effect — a disc leaving to the right — moves the
 * bbox centre so the BODY shifts the other way. Both read as the sprite popping
 * between frames.
 */
export function cellPlacement(cell: Cell, k: number): {
  sx: number; sy: number; sw: number; sh: number; dx: number; dy: number; dw: number; dh: number;
} {
  const [x0, y0, x1, y1] = cell;
  const sw = x1 - x0 + 1;
  const sh = y1 - y0 + 1;
  return {
    sx: x0, sy: y0, sw, sh,
    dx: (ART_BOX - sw * k) / 2, dy: ART_GROUND - sh * k, dw: sw * k, dh: sh * k,
  };
}

/**
 * THE 1:1 SCALE — one authored pixel per atlas texel.
 *
 * `artScale` answers a different question: "how big can this figure be without
 * leaving the art box". That is a FIT, so it lands on whatever fraction the
 * bounding box implies — measured on the shipped jester, 3.99 source pixels per
 * texel at the default rung and 2.79 at the closest, never an integer at any of
 * the five. Fractional means the reduce has to interpolate, which is the whole
 * reason imported art arrived soft.
 *
 * When a sheet HAS a lattice the scale is not a choice, it is arithmetic. One
 * authored pixel is `gridFactor` source pixels, and it must become exactly one
 * texel of an `atlasGrid`-texel cell, so:
 *
 *     art units per source pixel = ART_BOX / (gridFactor × atlasGrid)
 *
 * Nothing about the figure's size enters into it. What the figure's size does
 * decide is whether the result FITS — `fitsArtBox` below — because a sheet
 * authored too large for the cel cannot be scaled down without giving up the
 * 1:1 property, and silently shrinking it is exactly the failure this whole
 * function exists to remove.
 */
export function oneToOneScale(gridFactor: number, atlasGrid: number): number {
  return ART_BOX / (gridFactor * atlasGrid);
}

/** Does the sheet's largest living cell still fit the cel at the 1:1 scale? */
export function fitsArtBox(cells: readonly Cell[], k: number): boolean {
  const maxW = Math.max(...cells.map(([x0, , x1]) => x1 - x0 + 1));
  const maxH = Math.max(...cells.map(([, y0, , y1]) => y1 - y0 + 1));
  return maxW * k <= ART_FIT_W && maxH * k <= ART_FIT_H;
}
