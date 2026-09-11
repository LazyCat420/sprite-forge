/**
 * SLICING — a matted sheet into rows of cells.
 *
 * Extracted verbatim from `render/sprite-ingest.test.ts`, where it lived inside
 * the vitest file and therefore could only ever run in node. The browser refiner
 * (`/sprites`) needs the same code, and a re-implementation would drift the first
 * time a threshold moved — the same reasoning that killed the Python importer's
 * private copy of the palette.
 *
 * Everything here is pure: `Uint8ClampedArray` in, plain coordinates out. No
 * canvas, no filesystem, no DOM. That is what lets it run in vitest AND in the
 * browser without a shim.
 *
 * ⚠️ THIS FINDS CELLS BY ALPHA. It assumes matting already happened — see
 * `matte.ts`. Handed a sheet on an opaque background it returns ONE cell, which
 * is what the caller's guard is for.
 */

/** Transparent columns/rows narrower than this do not separate two cells. */
export const MIN_GAP = 6;
/** A run of opaque pixels smaller than this is a smudge, not a pose. */
export const MIN_CELL = 12;

/**
 * A row or column this full of opaque pixels is a RULED GRID LINE, not art.
 *
 * Real sheets are drawn with cell borders. They are opaque, so a naive
 * alpha-slice sees the whole sheet as ONE connected region and returns a single
 * cell — which is why this exists rather than being defensive programming.
 * Art never spans a whole sheet dimension; a ruled line always does.
 *
 * ⚠️ FILL ALONE IS NOT THE TEST, and believing it was cost this module its
 * whole reputation. Measured on `fixtures.ts` (see slice.test.ts):
 *
 *   · A RULE IS ALSO THIN. A figure's own solid core is a column of opaque
 *     pixels spanning the whole band, so a height-only test erases it. On an
 *     unruled sheet, 176 of 176 opaque columns were stripped: the figures
 *     vanished and the sheet sliced to NOTHING. The old comments blamed the art
 *     for "splitting inside a figure wherever a pose leaves a transparent
 *     column" — between the legs, either side of a spring. It does not: the
 *     slicer manufactured that column itself, then split around the hole.
 *
 *   · THE DENOMINATOR WAS WRONG. Fill was measured against the SHEET width, but
 *     a ragged sheet's short rows are nowhere near it. A 4-cell row inside a
 *     6-cell sheet fills 56%, so its borders survived and welded the row into
 *     one cell. That is the documented "1/6/1/1/1", and it reproduced exactly.
 *
 * Both are fixed below. `RULE_MAX_W` adds the width test; the per-band passes
 * now measure against the row's own extent.
 */
export const RULE_FILL = 0.7;

/**
 * A vertical rule may be at most this fraction of the band's HEIGHT in width.
 *
 * Scale-free on purpose. An absolute "3px" is a guess about the source
 * resolution and breaks the first time a sheet arrives upscaled 4x with 8px
 * borders. Expressed against the band, a ruled border is 1-3px of a ~120px cell
 * (1-2.5%) and a figure's core is 44px (37%) — measured on the fixture, that is
 * a 15x margin either side of this threshold, which is what makes it a
 * separation rather than a tuned constant.
 */
export const RULE_MAX_W = 0.1;
/** ...but never below this, so a short band cannot make the cap sub-pixel. */
export const RULE_MIN_W = 3;

/**
 * Bands shorter than this fraction of the median band are CAPTIONS.
 *
 * Sheets label their rows ("IDLE", "SPRING ATTACK", "DEATH"). The lettering
 * sits on the background between rows, so it slices as its own short band and
 * would otherwise be imported as a pose. A caption is an order of magnitude
 * shorter than a figure; 0.25 separates them with room to spare.
 *
 * ⚠️ THIS ONLY CATCHES CAPTIONS THAT SIT IN THEIR OWN BAND — i.e. above or below
 * a row. A caption in a LEFT GUTTER shares the row's band, so its height is the
 * row's height and this test never sees it; it then survives the width filter in
 * `sliceSheet` (a 6-letter word is well over a quarter of a cell) and imports as
 * a frame. Gutter labels have to be stripped before ingest, or declared as a
 * left margin in the recipe.
 */
export const CAPTION_RATIO = 0.25;

/** One cell, as `[x0, y0, x1, y1]` inclusive. */
export type Cell = [number, number, number, number];

export interface SheetRow {
  cells: Cell[];
}

/** Contiguous true runs, merging gaps under MIN_GAP and dropping tiny runs. */
export function bands(profile: boolean[]): [number, number][] {
  const out: [number, number][] = [];
  let start = -1;
  let gap = 0;
  for (let i = 0; i < profile.length; i++) {
    if (profile[i]) {
      if (start < 0) start = i;
      gap = 0;
    } else if (start >= 0 && ++gap > MIN_GAP) {
      if (i - gap - start >= MIN_CELL) out.push([start, i - gap]);
      start = -1;
    }
  }
  if (start >= 0 && profile.length - start >= MIN_CELL) out.push([start, profile.length - 1]);
  return out;
}

/**
 * Slice a sheet into ROWS of cells, discarding ruled grid lines and captions.
 *
 * Returns rows rather than a flat list because real sheets are ragged — one
 * observed sheet runs 4 / 6 / 4 / 2 / 3 across its five clips, and a row that
 * does not start at column 1. Flattening first would make "which frame belongs
 * to which clip" unrecoverable.
 */
export function sliceSheet(data: Uint8ClampedArray, w: number, h: number): SheetRow[] {
  const solid = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) solid[i] = data[i * 4 + 3] > 8 ? 1 : 0;

  // ── Strip ruled lines. A full-width row of opaque pixels is a border.
  //
  // ⚠️ MEASURED AS ONE CONTIGUOUS RUN, NOT AS TOTAL INK. Total ink counts a row
  // of separate figures the same as a line drawn through them, so a sheet of
  // BROAD creatures busts the threshold on the strength of the creatures alone.
  // Measured on `frog.png` — five wide frogs per row — the widest scanlines
  // reach 73% total ink and were erased as borders, so the idle cells came back
  // 57px tall against a ~150px frog and every frame shipped as a headless dome.
  //
  // Longest contiguous run separates them by construction, because a rule is a
  // LINE and five frogs are five blobs with gaps:
  //
  //     ruled border      ~100% contiguous
  //     frog row            15% contiguous  (73% total ink)
  //
  // Same lesson the VERTICAL pass below already learned — "a vertical rule is
  // SPANNING *AND* NARROW, fill alone is not enough".
  //
  // ⚠️ AND THINNESS IS THE OTHER HALF OF IT, which this pass was missing.
  //
  // Contiguous-run alone separates a rule from a ROW OF creatures, because that
  // row has gaps between the figures. It does NOT separate a rule from ONE wide
  // creature: a hound is a horizontal quadruped, so its back is a single
  // contiguous run the width of the animal, and every scanline through its body
  // was erased as a border. Intake guarantees the collision rather than risking
  // it — `reframeSubject` scales a wide subject up to `SUBJECT_W_MAX` (0.75),
  // which is ABOVE this 0.7 threshold, so a maximally-framed wide creature is
  // erased BY CONSTRUCTION. Measured on the hound's own idle: 2 rows / 3 cells
  // out of one clean single-blob figure, and `intake-qa` reported it as "the
  // slicer sees more than one figure — a caption, a border, or a second
  // component" on a frame that had none of those.
  //
  // A rule is a LINE in both axes: it spans, and it is THIN. A creature's body
  // spans for hundreds of consecutive scanlines. So require both, exactly as
  // the frame-sides pass below does, and the two cannot be confused:
  //
  //     ruled border      spans ~100%, 1-3px tall
  //     hound's back      spans   75%, ~440px tall
  const ruleCapH = Math.max(RULE_MIN_W, h * 0.01);
  const spanning: boolean[] = [];
  for (let y = 0; y < h; y++) {
    let run = 0;
    let best = 0;
    for (let x = 0; x < w; x++) {
      run = solid[y * w + x] ? run + 1 : 0;
      if (run > best) best = run;
    }
    spanning.push(best >= w * RULE_FILL);
  }
  for (let y = 0; y < h; ) {
    if (!spanning[y]) { y++; continue; }
    let end = y;
    while (end + 1 < h && spanning[end + 1]) end++;
    if (end - y + 1 <= ruleCapH) {
      for (let yy = y; yy <= end; yy++) for (let x = 0; x < w; x++) solid[yy * w + x] = 0;
    }
    y = end + 1;
  }
  // ── The OUTER frame's sides, and only those.
  //
  // A frame drawn around the whole sheet puts ink in every row, so the row
  // profile never breaks and the entire sheet reads as ONE band — measured, a
  // ruled 5-row sheet with an outer frame sliced to a single row of 3.
  //
  // This is safe here and catastrophic one paragraph down (see below) because
  // of the threshold: an outer frame spans ~100% of the sheet height, where a
  // CELL border in a 5-row sheet spans about 18%. Requiring near-total height
  // AND a narrow run catches the frame and cannot touch anything else.
  const frameCap = Math.max(RULE_MIN_W, h * 0.01);
  const fullH: boolean[] = [];
  for (let x = 0; x < w; x++) {
    let n = 0;
    for (let y = 0; y < h; y++) n += solid[y * w + x];
    fullH.push(n >= h * 0.98);
  }
  for (let x = 0; x < w; ) {
    if (!fullH[x]) { x++; continue; }
    let end = x;
    while (end + 1 < w && fullH[end + 1]) end++;
    if (end - x + 1 <= frameCap) {
      for (let xx = x; xx <= end; xx++) for (let y = 0; y < h; y++) solid[y * w + xx] = 0;
    }
    x = end + 1;
  }

  // ⚠️ CELL BORDERS ARE STRIPPED PER-BAND, NOT SHEET-WIDE, and that is the
  // whole difference between this working and not. A cell border is only as
  // tall as ITS ROW, so against the full sheet height a 5-row sheet's border
  // fills about 18% — nowhere near any sensible threshold — and survives. It
  // then bridges the gap between neighbouring cells and the entire row slices as
  // ONE frame. Measured on a fixture with ruled cells: sheet-wide stripping gave
  // rows of 1/6/1/1/1 where the truth was 4/6/4/2/3.

  const at = (x: number, y: number): boolean => solid[y * w + x] === 1;
  const rowProfile: boolean[] = [];
  for (let y = 0; y < h; y++) {
    let any = false;
    for (let x = 0; x < w && !any; x++) any = at(x, y);
    rowProfile.push(any);
  }

  // ── Drop caption bands, by height against the median band.
  const raw = bands(rowProfile);
  const heights = raw.map(([a, b]) => b - a + 1).sort((a, b) => a - b);
  const median = heights[Math.floor(heights.length / 2)] ?? 0;
  const keep = raw.filter(([a, b]) => b - a + 1 >= median * CAPTION_RATIO);

  const out: SheetRow[] = [];
  for (const [y0, y1] of keep) {
    const bandH = y1 - y0 + 1;
    // Band-local copy with rules stripped on BOTH axes. A cell's top and bottom
    // edges span its full width, so leaving them in makes every column look like
    // content and welds the row back together.
    const band = new Uint8Array(w * bandH);
    for (let y = 0; y < bandH; y++) for (let x = 0; x < w; x++) band[y * w + x] = at(x, y0 + y) ? 1 : 0;

    // ── Fill is measured against THIS ROW's extent, not the sheet's.
    //
    // A ragged sheet's short rows never reach 70% of the sheet width, so their
    // ruled borders used to survive and weld the row into a single cell. The
    // row's own bounding box is the only denominator that means the same thing
    // for a 2-cell row and a 6-cell one.
    let bx0 = w;
    let bx1 = -1;
    for (let y = 0; y < bandH; y++) {
      for (let x = 0; x < w; x++) {
        if (!band[y * w + x]) continue;
        if (x < bx0) bx0 = x;
        if (x > bx1) bx1 = x;
      }
    }
    const rowW = bx1 - bx0 + 1;

    // Contiguity again, same reason as the sheet-wide pass: this measures against
    // the ROW's own extent, so a broad-creature row scores even higher here —
    // and THICKNESS again for the same reason, harder. Against the band's own
    // extent a lone wide creature's body spans 100%, not 75%, so no fill
    // threshold can survive it: the sheet-wide fix alone left the hound's four
    // legs standing as four cells with the body erased between them.
    const bandRuleCap = Math.max(RULE_MIN_W, bandH * 0.05);
    const spans: boolean[] = [];
    for (let y = 0; y < bandH; y++) {
      let run = 0;
      let best = 0;
      for (let x = 0; x < w; x++) {
        run = band[y * w + x] ? run + 1 : 0;
        if (run > best) best = run;
      }
      spans.push(best >= rowW * RULE_FILL);
    }
    let ruled = false;
    for (let y = 0; y < bandH; ) {
      if (!spans[y]) { y++; continue; }
      let end = y;
      while (end + 1 < bandH && spans[end + 1]) end++;
      if (end - y + 1 <= bandRuleCap) {
        for (let yy = y; yy <= end; yy++) for (let x = 0; x < w; x++) band[yy * w + x] = 0;
        ruled = true;
      }
      y = end + 1;
    }

    // ── A CELL BORDER IS A RECTANGLE: no vertical rules without horizontal ones.
    //
    // This gate is what makes the vertical pass safe, and skipping it is what
    // made the old code erase entire figures. On an UNRULED sheet there are no
    // rules to find, so any column the vertical test flags is art by
    // construction — and it flagged all of it (176 of 176 columns, sheet sliced
    // to nothing). No width threshold rescues that, because there is no second
    // population to separate from: measured on a 3x-scale fixture, a cap of 10%
    // of the band still ate the 21px strips where the figure's head overlaps its
    // legs and split every pose into three (12/18/12/6/9 against 4/6/4/2/3).
    //
    // A frame is drawn as a box. If this band contained no horizontal rule, it
    // has no frame, and the vertical pass has nothing legitimate to do.
    // (A sheet separated by vertical lines ALONE would be missed — it also
    // slices correctly on alpha gaps, so nothing is lost by not handling it.)
    if (ruled) {
      // ── A vertical rule is SPANNING *AND* NARROW.
      //
      // Fill alone is not enough. A ruled frame inflates the band past the art
      // it contains — 118px of frame around a 95px figure — which drops the 70%
      // gate to 82.6 and lets the few narrow columns of the figure that DO clear
      // it be stripped, punching holes through the middle of the pose
      // (measured: 4/7/5/3/4). A border runs the full height of its cell, so it
      // is opaque at BOTH band edges; art is inset and never reaches them.
      //
      // Candidates are cleared as RUNS, not columns: two neighbouring cells'
      // borders touch and read as one 2px rule, which is still a rule.
      const capW = Math.max(RULE_MIN_W, bandH * RULE_MAX_W);
      const tall: boolean[] = [];
      for (let x = 0; x < w; x++) {
        let n = 0;
        for (let y = 0; y < bandH; y++) n += band[y * w + x];
        tall.push(n >= bandH * RULE_FILL && band[x] === 1 && band[(bandH - 1) * w + x] === 1);
      }
      for (let x = 0; x < w; ) {
        if (!tall[x]) { x++; continue; }
        let end = x;
        while (end + 1 < w && tall[end + 1]) end++;
        if (end - x + 1 <= capW) {
          for (let xx = x; xx <= end; xx++) for (let y = 0; y < bandH; y++) band[y * w + xx] = 0;
        }
        x = end + 1;
      }
    }

    const inBand = (x: number, y: number): boolean => band[(y - y0) * w + x] === 1;
    const colProfile: boolean[] = [];
    for (let x = 0; x < w; x++) {
      let any = false;
      for (let y = y0; y <= y1 && !any; y++) any = inBand(x, y);
      colProfile.push(any);
    }
    const cells: [number, number, number, number, number][] = [];
    for (const [x0, x1] of bands(colProfile)) {
      // Tighten vertically to this cell's own ink — the band is the union
      // across the row, and a crouched pose is shorter than its neighbours.
      let ty = y1, by = y0, mass = 0;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          if (!inBand(x, y)) continue;
          mass++;
          ty = Math.min(ty, y);
          by = Math.max(by, y);
        }
      }
      if (by >= ty) cells.push([x0, ty, x1, by, mass]);
    }
    // Reject FRAGMENTS by WIDTH against the row's median cell.
    //
    // Mass is the wrong test and was tried first: a leftover ruled border is
    // long, so it carries real mass (a 2x260 edge is 520 px) and survived a 2%
    // threshold, then crushed to 8 texels and tripped the empty-cell guard.
    // Width is the discriminator — a border remnant is a couple of pixels wide
    // where a pose is a couple of hundred — and it stays correct for a small
    // pose, which a mass test does not: a death sprawl is legitimately light.
    const widths = cells.map((c) => c[2] - c[0] + 1).sort((a, b) => a - b);
    const medianW = widths[Math.floor(widths.length / 2)];
    const real = cells
      .filter((c) => c[2] - c[0] + 1 >= medianW * 0.25 && c[4] > 0)
      .map((c) => [c[0], c[1], c[2], c[3]] as Cell);

    // Auto-split merged multi-frame cells (width > 1.75x medianW)
    const splitCells: Cell[] = [];
    for (const c of real) {
      const cw = c[2] - c[0] + 1;
      if (cw > medianW * 1.75 && medianW > 30) {
        const midStart = Math.floor(c[0] + cw * 0.25);
        const midEnd = Math.floor(c[2] - cw * 0.25);
        let minInk = Infinity;
        let splitX = Math.floor((c[0] + c[2]) / 2);
        for (let x = midStart; x <= midEnd; x++) {
          let ink = 0;
          for (let y = c[1]; y <= c[3]; y++) {
            if (inBand(x, y)) ink++;
          }
          if (ink <= minInk) {
            minInk = ink;
            splitX = x;
          }
        }
        splitCells.push([c[0], c[1], splitX - 1, c[3]]);
        splitCells.push([splitX + 1, c[1], c[2], c[3]]);
      } else {
        splitCells.push(c);
      }
    }
    if (splitCells.length) out.push({ cells: splitCells });
  }
  return out;
}

/**
 * Re-cut a band into exactly `n` equal columns across its own opaque extent.
 *
 * ── THIS IS NO LONGER THE NORMAL PATH ────────────────────────────────────────
 *
 * It was written because auto-slicing a ruled sheet "does not work" — measured
 * at 5/12/5/2/1 against a truth of 4/6/4/2/3 — and the recipe therefore had to
 * carry a cell count for every row. That diagnosis was wrong. The slicer was
 * erasing figures and welding rows (see `RULE_FILL`); with those two defects
 * fixed, all six layouts in slice.test.ts — ruled, unruled, shared borders,
 * gutters, indented, touching figures — slice to 4/6/4/2/3 with no count at all.
 *
 * Kept as an OVERRIDE for the sheet that still fools the alpha pass: two poses
 * genuinely touching with no gap between them read as one cell, and no
 * threshold recovers that from pixels alone.
 *
 * ⚠️ IT DIVIDES THE INK EXTENT, NOT THE CELL EXTENT. A row whose first pose is
 * narrow and inset, or whose last pose stops short of its cell, has an ink
 * extent smaller than its true grid extent — so the pitch is slightly wrong and
 * the error ACCUMULATES across the row. Prefer letting the slicer find the
 * cells; reach for this only when it visibly cannot.
 */
export function equalCells(band: SheetRow, n: number): Cell[] {
  const x0 = Math.min(...band.cells.map((c) => c[0]));
  const x1 = Math.max(...band.cells.map((c) => c[2]));
  const y0 = Math.min(...band.cells.map((c) => c[1]));
  const y1 = Math.max(...band.cells.map((c) => c[3]));
  const pitch = (x1 - x0 + 1) / n;
  return Array.from({ length: n }, (_, i) => [
    Math.round(x0 + i * pitch), y0, Math.round(x0 + (i + 1) * pitch) - 1, y1,
  ] as Cell);
}
