/**
 * REGISTRATION — a sliced cell onto the painters' contract, then through the
 * real crush.
 *
 * This is the stage that decides where an imported figure STANDS and how BIG it
 * is, and both answers have to match what a painter would have produced, or the
 * import reads as a different creature at a different scale on the same floor.
 *
 * Extracted from `sprite-ingest.test.ts`. Behaviour is unchanged; the two magic
 * numbers that were inline are now named and the third comes from the engine.
 */
import { crushToGrid, CX, GROUND } from "../../engine/render/crush";
import { resampleCell, upscaleExact } from "./resample";
import { blockReduce } from "./grid";
import type { Cell } from "./slice";

/**
 * The painters' cel box. Everything an actor draws is placed in a 128×128 art
 * space with the feet on `GROUND` and the body centred on `CX`; the rasteriser
 * scales that box to `SPRITE_PX` for whatever rung is live.
 */
export const ART_SPACE = CX * 2;

/**
 * The box an imported figure is allowed to fill inside the cel, in art units.
 *
 * Slightly under the full 128 on both axes: a painter's silhouette is authored
 * to leave room for its own selout and contact shadow, and an imported figure
 * scaled to the full box would be visibly the largest thing on the floor. These
 * are ingest's own numbers, not an engine contract — the engine only fixes
 * `GROUND` and `CX`.
 */
export const ART_W = 108;
export const ART_H = 110;

/**
 * ONE uniform scale for the WHOLE sheet — in device px per source px.
 *
 * Per-cell normalisation is the obvious alternative and it is wrong: it makes
 * the flipbook pulse, because every frame would be scaled to its own extent and
 * a crouched pose would inflate to the same height as a standing one. So the
 * scale is set by the sheet's most extreme frame and every other frame pays for
 * it — which is exactly why a sheet must not waste its extent on an extended
 * spring or a projectile that has already left the actor.
 *
 * Callers that know their clip names should pass only the LIVING cells here
 * (everything but `death`) and clamp the rest with `cellScalePx` — the same
 * alive-vote `aliveScale`/`cellScale` implement for the game, in art units.
 * The jester's flat death sprawl setting the whole sheet's scale is what that
 * split exists to prevent; `aliveScale`'s header carries the numbers.
 */
export function sheetScale(cells: readonly Cell[], px: number): number {
  const unit = px / ART_SPACE;
  const maxW = Math.max(...cells.map(([x0, , x1]) => x1 - x0 + 1));
  const maxH = Math.max(...cells.map(([, y0, , y1]) => y1 - y0 + 1));
  return Math.min((ART_W * unit) / maxW, (ART_H * unit) / maxH);
}

/**
 * Per-cell clamp for frames the alive vote no longer accounts for: a death
 * cell may overflow at the alive scale, and pays for it alone — clamped to
 * the HARD cel limits (full box width, the ground line), not the fit margin.
 * Mirrors `manifest.cellScale`.
 */
export function cellScalePx(cell: Cell, k: number, px: number): number {
  const unit = px / ART_SPACE;
  const [x0, y0, x1, y1] = cell;
  return Math.min(k, (ART_SPACE * unit) / (x1 - x0 + 1), (GROUND * unit) / (y1 - y0 + 1));
}

/**
 * Blit one source cell into a fresh pre-crush buffer, centred and grounded.
 *
 * ⚠️ REGISTRATION IS BY BOUNDING BOX, not by the figure's feet. The cell is
 * centred on its own opaque extent and its LOWEST ink is planted on `GROUND`.
 * That is correct for a grounded pose and wrong for two cases the art has to
 * avoid: debris drawn below the feet lifts the character off the floor, and an
 * asymmetric effect (a projectile leaving to the right) moves the bbox centre,
 * so the BODY shifts the other way. Both read as the sprite popping between
 * frames. A declared per-frame anchor is the eventual fix; keeping effects off
 * the actor sheet is the cheap one.
 *
 * The resample is `resampleCell`, not a smoothed `drawImage` — the same
 * k-centroid filter the game runs in `render/imported-paints.ts`, so the
 * forge's report and previews describe the pixels that actually ship. (The
 * old warning here — "resampling twice cost isolated 34.9% → 42.7%" — was
 * measured on stacked BILINEAR hops. The area filter composes: coverage-
 * weighted source→cel followed by the crush's exact 2:1 box is one box
 * filter, not two lossy ones.)
 */
export function registerCell(
  source: CanvasImageSource,
  cell: Cell,
  k: number,
  px: number,
  align = 1,
  gridN = 0,
): HTMLCanvasElement {
  const [x0, y0, x1, y1] = cell;
  const cw = x1 - x0 + 1;
  const ch = y1 - y0 + 1;
  const dw = Math.max(1, Math.round(cw * k));
  const dh = Math.max(1, Math.round(ch * k));

  // Cut the cell 1:1 — no resample — then filter it deliberately.
  const cut = document.createElement("canvas");
  cut.width = cw;
  cut.height = ch;
  const cctx = cut.getContext("2d", { willReadFrequently: true });
  if (!cctx) throw new Error("[ingest] could not get a 2D context for the cell cut");
  cctx.drawImage(source, x0, y0, cw, ch, 0, 0, cw, ch);
  // A COMMITTED cell (`gridN` > 1) is reduced by exact block majority and
  // replicated back up by whole blocks — the same fast path the runtime takes
  // in `render/imported-paints.ts` `buildCel`. The forge must not preview a
  // k-centroid resample of a sheet the game will block-copy: the report has to
  // describe the pixels that actually ship.
  const tw = gridN > 1 ? Math.round(cw / gridN) : 0;
  const th = gridN > 1 ? Math.round(ch / gridN) : 0;
  const exactUp =
    gridN > 1 && tw > 0 && th > 0 && cw === tw * gridN && ch === th * gridN &&
    dw % tw === 0 && dw / tw === dh / th
      ? dw / tw
      : 0;
  const small = exactUp >= 1
    ? upscaleExact(blockReduce(cctx.getImageData(0, 0, cw, ch), gridN, x0 % gridN, y0 % gridN), exactUp)
    : resampleCell(cctx.getImageData(0, 0, cw, ch), dw, dh);

  const buf = document.createElement("canvas");
  buf.width = px;
  buf.height = px;
  const ctx = buf.getContext("2d");
  if (!ctx) throw new Error("[ingest] could not get a 2D context for the cel buffer");
  const img = ctx.createImageData(dw, dh);
  img.data.set(small.data);
  // ⚠️ ALIGN THE ORIGIN TO THE CRUSH'S OWN STRIDE.
  //
  // The crush reduces this buffer by `px/grid`, in windows anchored at 0. A cel
  // landing on an odd offset therefore has every window straddling TWO of its
  // pixels, and averaging across that boundary invents colours — which is the
  // whole failure a committed sheet exists to remove. Measured on the committed
  // jester: centring put the cel at x=41 and the census read 25.7 entries and 6
  // invented against a source holding exactly 20 and inventing none.
  //
  // `align` is 1 (no-op) for a resampled sheet, where there are no authored
  // block boundaries to preserve and centring is worth more than parity.
  const snap = (v: number): number => (align > 1 ? Math.round(v / align) * align : Math.round(v));
  ctx.putImageData(img, snap((px - dw) / 2), snap(GROUND * (px / ART_SPACE) - dh));
  return buf;
}

/** The pre-crush buffer through the REAL crush, at `grid` texels. */
export function crushCell(
  buf: HTMLCanvasElement,
  grid: number,
  /** This sheet's own palette entries, appended to the shared ones. */
  pal?: readonly (readonly number[])[],
): ImageData {
  const cell = crushToGrid(buf, grid, pal);
  const ctx = cell.getContext("2d");
  if (!ctx) throw new Error("[ingest] could not get a 2D context for the crushed cell");
  return ctx.getImageData(0, 0, grid, grid);
}
