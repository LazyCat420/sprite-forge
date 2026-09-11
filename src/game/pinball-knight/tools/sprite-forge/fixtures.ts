/**
 * SYNTHETIC SHEETS — the inputs the slicer is documented to handle, built in code.
 *
 * ⚠️ WHY THIS EXISTS. `sliceSheet` shipped with no test at all. Its only caller
 * was the inbox loop, and the inbox is empty, so `npm run sprites` was GREEN
 * while executing none of it — and every measured claim in its comments
 * ("returned 5/12/5/2/1 where the truth was 4/6/4/2/3", "sheet-wide stripping
 * gave 1/6/1/1/1") came from a fixture that was never committed. A green suite
 * that exercises nothing is the failure mode this repo keeps rediscovering.
 *
 * These are drawn as raw RGBA rather than through a canvas so they are exact:
 * no antialiasing, no smoothing, every pixel placed on purpose. A fixture whose
 * edges are soft would make the alpha threshold the thing under test.
 */

/** A figure is drawn from these three bars — head, body, and two legs. */
interface Figure {
  /** Leave a transparent column between the legs (the real "pose gap" case). */
  legGap: boolean;
  /** Overhang each side, in px — how a neighbour's art comes to touch. */
  overhang: number;
}

export interface SheetSpec {
  /** Cells per row. Ragged is the normal case: [4, 6, 4, 2, 3]. */
  rows: number[];
  cellW: number;
  cellH: number;
  /** Transparent px between cells. 0 means neighbours share a ruled border. */
  gutter: number;
  margin: number;
  /** Draw 1px cell borders — a "ruled" sheet. */
  ruled: boolean;
  /** Draw a short caption bar under each row, in its own band. */
  captions: boolean;
  /** This row starts one cell in from the left. */
  indentRow?: number;
  /** This row's figures overhang their cells and touch their neighbours. */
  touchingRow?: number;
  /** Fill the background opaque with this RGB instead of leaving it clear. */
  opaqueBg?: [number, number, number];
  /** Draw the row label in the LEFT GUTTER instead of under the row. */
  gutterLabels?: boolean;
  /**
   * Paint a patch of the BACKGROUND COLOUR inside each figure's body.
   *
   * The clown's ruff, gloves and face against a cream field — art that a global
   * "remove everything near white" key destroys, and that a border flood fill
   * cannot reach. The one property matting has to get right.
   */
  interiorLight?: boolean;
  /** A ruled frame around the whole sheet, so the CORNERS are border, not field. */
  sheetFrame?: boolean;
  /** Shade the background as a left-to-right ramp — a sheet that cannot be keyed. */
  gradientBg?: boolean;
  /**
   * Darken alternate 8px squares by this much — a TRANSPARENCY CHECKERBOARD
   * baked into the pixels.
   *
   * What both real sheets turned out to be: jester alternates rgb(252)/rgb(243)
   * and beaver rgb(253)/rgb(246). The background is two colours, not one, and a
   * fixed tolerance leaves every darker square behind as opaque speckle.
   */
  checkerBg?: number;
}

export const DEFAULT_SPEC: SheetSpec = {
  rows: [4, 6, 4, 2, 3],
  cellW: 100,
  cellH: 120,
  gutter: 0,
  margin: 8,
  ruled: true,
  captions: true,
  indentRow: 3,
  touchingRow: undefined,
  opaqueBg: undefined,
  gutterLabels: false,
};

/** Height of a caption bar, and the clear space that separates it from the art. */
const CAPTION_H = 9;
const CAPTION_GAP = 10;
const LABEL_W = 52;

/**
 * Clear space between one row's band and the next, ALWAYS — independent of
 * `gutter`, which is the space between CELLS.
 *
 * ⚠️ Load-bearing, and it cost an hour to find. Without it a captioned row's
 * label sits flush against the next row's frame, the two merge into a single
 * band, and the band is then taller than the frame inside it — so that frame's
 * borders no longer touch the band's top edge and the spanning test in slice.ts
 * stops recognising them. The row then welds. A real sheet leaves air on both
 * sides of a caption; a fixture that does not is testing a malformed sheet and
 * blaming the slicer.
 */
const ROW_GAP = 14;

export interface Sheet {
  data: Uint8ClampedArray;
  w: number;
  h: number;
}

/**
 * Build a sheet to spec.
 *
 * Row pitch includes the caption band when captions are on, so a caption always
 * lands in its own band with more than `MIN_GAP` of clear space either side —
 * which is the only arrangement `CAPTION_RATIO` can reject. A caption placed
 * INSIDE the row band (a left gutter label) is a different case and is what
 * `gutterLabels` reproduces.
 */
export function buildSheet(over: Partial<SheetSpec> = {}): Sheet {
  const s = { ...DEFAULT_SPEC, ...over };
  const maxCells = Math.max(...s.rows);
  const gutterPad = s.gutterLabels ? LABEL_W + s.gutter + 4 : 0;
  const bandH = s.cellH + (s.captions ? CAPTION_GAP + CAPTION_H : 0);
  // +1 cell of slack on the right so an indented row still fits.
  const w = s.margin * 2 + gutterPad + (maxCells + 1) * (s.cellW + s.gutter);
  const h = s.margin * 2 + s.rows.length * (bandH + ROW_GAP);
  const data = new Uint8ClampedArray(w * h * 4);

  const px = (x: number, y: number, r: number, g: number, b: number, a = 255): void => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 4;
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
  };
  const rect = (x: number, y: number, rw: number, rh: number, c: [number, number, number]): void => {
    for (let yy = y; yy < y + rh; yy++) for (let xx = x; xx < x + rw; xx++) px(xx, yy, c[0], c[1], c[2]);
  };
  const frame = (x: number, y: number, rw: number, rh: number, c: [number, number, number]): void => {
    rect(x, y, rw, 1, c); rect(x, y + rh - 1, rw, 1, c);
    rect(x, y, 1, rh, c); rect(x + rw - 1, y, 1, rh, c);
  };

  if (s.opaqueBg) rect(0, 0, w, h, s.opaqueBg);
  if (s.checkerBg) {
    const base = s.opaqueBg ?? [240, 237, 230];
    const k = s.checkerBg;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (((x >> 3) + (y >> 3)) % 2 === 0) continue;
        px(x, y, base[0] - k, base[1] - k, base[2] - k);
      }
    }
  }
  if (s.gradientBg) {
    const base = s.opaqueBg ?? [240, 237, 230];
    for (let x = 0; x < w; x++) {
      // A STRONG ramp, deliberately. A gentle one is genuinely keyable — the
      // fill reaches all of it at one tolerance — so it must not fail, and a
      // fixture that ramps by ±30 would be asserting the wrong thing.
      const k = Math.round((x / w) * 180) - 90;
      for (let y = 0; y < h; y++) px(x, y, base[0] + k, base[1] + k, base[2] + k);
    }
  }

  const INK: [number, number, number] = [40, 30, 30];
  const BODY: [number, number, number] = [200, 60, 50];
  const HEAD: [number, number, number] = [230, 200, 90];
  /** The "white glove": exactly the field colour, but inside the silhouette. */
  const LIGHT: [number, number, number] = s.opaqueBg ?? [240, 237, 230];

  const figure = (cx: number, top: number, f: Figure): void => {
    const bw = Math.floor(s.cellW * 0.44) + f.overhang * 2;
    const hw = Math.floor(s.cellW * 0.30);
    const hh = Math.floor(s.cellH * 0.16);
    const bh = Math.floor(s.cellH * 0.42);
    const lh = Math.floor(s.cellH * 0.22);
    // head
    rect(cx - (hw >> 1), top, hw, hh, HEAD);
    // body
    rect(cx - (bw >> 1), top + hh, bw, bh, BODY);
    // legs — with or without the transparent column between them
    const lw = Math.floor(bw * (f.legGap ? 0.32 : 0.5));
    const ly = top + hh + bh;
    rect(cx - (bw >> 1), ly, lw, lh, BODY);
    rect(cx + (bw >> 1) - lw, ly, lw, lh, BODY);
    // The ruff/glove: field-coloured, but walled in by the body on every side.
    if (s.interiorLight) rect(cx - 6, top + hh + 6, 12, 10, LIGHT);
  };

  s.rows.forEach((count, ri) => {
    const bandTop = s.margin + ri * (bandH + ROW_GAP);
    const indent = ri === s.indentRow ? 1 : 0;
    const rowLeft = s.margin + gutterPad + indent * (s.cellW + s.gutter);
    const overhang = ri === s.touchingRow ? Math.floor(s.gutter / 2) + 6 : 0;

    if (s.gutterLabels) rect(s.margin, bandTop + (s.cellH >> 1), LABEL_W, CAPTION_H, INK);

    for (let ci = 0; ci < count; ci++) {
      const cellLeft = rowLeft + ci * (s.cellW + s.gutter);
      if (s.ruled) frame(cellLeft, bandTop, s.cellW, s.cellH, INK);
      // Poses sit on the cell's floor, inset from the ruled border.
      const figTop = bandTop + Math.floor(s.cellH * 0.14);
      figure(cellLeft + (s.cellW >> 1), figTop, { legGap: true, overhang });
    }

    if (s.captions) {
      const capLeft = rowLeft + Math.floor((count * (s.cellW + s.gutter)) / 2) - 30;
      rect(capLeft, bandTop + s.cellH + CAPTION_GAP, 60, CAPTION_H, INK);
    }
  });

  // Drawn LAST so it is not overpainted: this is what puts a border colour in
  // every corner, which is why the background estimate samples the whole ring.
  if (s.sheetFrame) frame(0, 0, w, h, INK);

  return { data, w, h };
}

/** The shape a sheet sliced into, as `4/6/4/2/3` — the one-glance diff. */
export function shapeOf(rows: readonly { cells: unknown[] }[]): string {
  return rows.map((r) => r.cells.length).join("/");
}
