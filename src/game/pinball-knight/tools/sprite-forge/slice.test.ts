/**
 * WHAT THE ALPHA SLICER ACTUALLY DOES.
 *
 * A characterisation suite, not an aspirational one. `sliceSheet` shipped
 * untested: its only caller was the inbox loop, and the inbox is empty, so
 * `npm run sprites` was GREEN while executing none of it — and every measured
 * claim in its comments came from a fixture that was never committed.
 *
 * These tests pin the behaviour as it is, INCLUDING WHERE IT IS WRONG, so that
 * `grid.ts` replacing it is a visible diff rather than a claim. Two of them
 * assert a defect. They are marked, and they are the reason the next stage
 * exists.
 */
import { describe, it, expect } from "vitest";
import { sliceSheet } from "./slice";
import { buildSheet, shapeOf } from "./fixtures";

const RAGGED = [4, 6, 4, 2, 3];
const TRUTH = RAGGED.join("/");

describe("sliceSheet — rows", () => {
  it("finds one band per row, and captions are not rows", () => {
    const { data, w, h } = buildSheet({ rows: RAGGED, captions: true });
    // Five clips in, five bands out. With captions counted this would be ten —
    // the caption test is the only thing between a label bar and a "pose".
    expect(sliceSheet(data, w, h).length).toBe(RAGGED.length);
  });

  it("keeps the row count when a row is indented", () => {
    const { data, w, h } = buildSheet({ rows: RAGGED, indentRow: 3 });
    expect(sliceSheet(data, w, h).length).toBe(RAGGED.length);
  });
});

describe("sliceSheet — cells", () => {
  it("recovers ragged cell counts from an unruled sheet, with no sidecar", () => {
    const { data, w, h } = buildSheet({ rows: RAGGED, ruled: false, gutter: 12 });
    // THE CANONICAL TARGET FORMAT — transparent, no grid lines, no gutter
    // labels, clear space between cells. It used to slice to NOTHING: the
    // height-only rule test stripped 176 of 176 opaque columns and erased every
    // figure. Requiring a rule to be narrow as well fixes it exactly.
    expect(shapeOf(sliceSheet(data, w, h))).toBe(TRUTH);
  });

  it("an indented row divides on its own extent", () => {
    const { data, w, h } = buildSheet({ rows: RAGGED, ruled: false, gutter: 12, indentRow: 3 });
    expect(shapeOf(sliceSheet(data, w, h))).toBe(TRUTH);
  });

  it("a transparent column inside a pose does not split it", () => {
    // Legs apart, one cell. The leg gap was blamed in the shipped comments for
    // splitting figures. It never was the cause — and now that the figure is
    // not being erased first, it demonstrably does not split anything.
    const { data, w, h } = buildSheet({ rows: [1], ruled: false, captions: false });
    const rows = sliceSheet(data, w, h);
    expect(rows.length).toBe(1);
    expect(rows[0].cells.length).toBe(1);
  });

  it("a figure's solid core is not mistaken for a rule at any sheet scale", () => {
    // 3x everything. Scale used to matter: with a width-only cap the 21px strips
    // where the figure's head overlaps its legs were stripped as rules and every
    // pose split into three — 12/18/12/6/9. The rectangle gate removes the
    // question, because an unruled sheet never runs the vertical pass at all.
    const { data, w, h } = buildSheet({ rows: RAGGED, ruled: false, gutter: 36, cellW: 300, cellH: 360 });
    expect(shapeOf(sliceSheet(data, w, h))).toBe(TRUTH);
  });

  /**
   * THE LAYOUTS A GENERATOR ACTUALLY EMITS, all against one truth.
   *
   * Every one of these returned something wrong before: the unruled cases
   * sliced to nothing, the ruled ones to 9/7/9/5/7. Kept as a table because the
   * point is that layout stopped mattering — the recipe no longer has to carry
   * a cell count for any of them.
   */
  const LAYOUTS: [string, Parameters<typeof buildSheet>[0]][] = [
    ["ruled, shared borders", { ruled: true, gutter: 0 }],
    ["ruled, gutter", { ruled: true, gutter: 12 }],
    ["ruled, indented row", { ruled: true, gutter: 0, indentRow: 3 }],
    ["ruled, touching figures", { ruled: true, gutter: 0, touchingRow: 1 }],
    ["unruled, touching figures", { ruled: false, gutter: 12, touchingRow: 1 }],
    ["unruled, no gutter", { ruled: false, gutter: 0 }],
  ];
  it.each(LAYOUTS)("slices %s to the true cell counts", (_label, spec) => {
    const { data, w, h } = buildSheet({ rows: RAGGED, ...spec });
    expect(shapeOf(sliceSheet(data, w, h))).toBe(TRUTH);
  });
});

describe("sliceSheet — the inputs it cannot take", () => {
  it("an opaque background collapses the whole sheet to one cell", () => {
    const { data, w, h } = buildSheet({ rows: RAGGED, opaqueBg: [240, 237, 230] });
    const cells = sliceSheet(data, w, h).flatMap((r) => r.cells);
    // THE ONLY INPUT AN AI GENERATOR PRODUCES. Diffusion models have no alpha
    // channel, so every generated sheet arrives like this. One cell is the
    // caller's cue to fail loudly — and the reason matte.ts has to run first.
    expect(cells.length).toBeLessThanOrEqual(1);
  });

  it("a row label in the LEFT GUTTER imports as a frame", () => {
    const plain = buildSheet({ rows: [4], captions: false, gutterLabels: false });
    const labelled = buildSheet({ rows: [4], captions: false, gutterLabels: true });
    const before = shapeOf(sliceSheet(plain.data, plain.w, plain.h));
    const after = shapeOf(sliceSheet(labelled.data, labelled.w, labelled.h));
    // Moving a caption from UNDER a row into its LEFT GUTTER defeats the caption
    // test entirely: the label shares the row's band, so its height IS the row's
    // height and CAPTION_RATIO never sees it. It then clears the 25% width
    // filter and becomes a pose. Sheets must not label their gutters.
    expect(after).not.toBe(before);
  });
});

describe("a row of BROAD creatures is not a ruled line", () => {
  /**
   * `frog.png`: five wide frogs per row reach 73% TOTAL ink on their widest
   * scanlines, over the 70% rule threshold, so those scanlines were erased as
   * borders — the idle cells came back 57px tall against a ~150px frog and every
   * frame shipped as a headless dome.
   *
   * Contiguity separates them because a rule is a LINE: the frogs' longest
   * unbroken run is one frog wide (15%), a border's is the whole sheet.
   */
  const W = 400, H = 120;
  const build = (draw: (set: (x: number, y: number) => void) => void): Uint8ClampedArray => {
    const d = new Uint8ClampedArray(W * H * 4);
    draw((x, y) => { if (x >= 0 && x < W && y >= 0 && y < H) d[(y * W + x) * 4 + 3] = 255; });
    return d;
  };

  it("keeps a scanline that is 75% ink but broken into blobs", () => {
    // Five blobs of 60px with 20px gaps = 300/400 = 75% ink, longest run 60 (15%).
    const data = build((set) => {
      for (let b = 0; b < 5; b++)
        for (let x = b * 80; x < b * 80 + 60; x++)
          for (let y = 30; y < 90; y++) set(x, y);
    });
    const rows = sliceSheet(data, W, H);
    expect(rows.length).toBe(1);
    expect(rows[0].cells.length).toBe(5);
    // and the FULL height survives — the defect truncated it
    const [, y0, , y1] = rows[0].cells[0];
    expect(y1 - y0 + 1).toBeGreaterThanOrEqual(55);
  });

  it("ANTI-VACUITY: an actual full-width rule is still stripped", () => {
    // Same blobs, plus a genuine 2px border across the whole sheet. If the rule
    // test were simply disabled, this row would weld into one cell.
    const data = build((set) => {
      for (let b = 0; b < 5; b++)
        for (let x = b * 80; x < b * 80 + 60; x++)
          for (let y = 30; y < 90; y++) set(x, y);
      for (let x = 0; x < W; x++) { set(x, 58); set(x, 59); }
    });
    const rows = sliceSheet(data, W, H);
    expect(rows[0].cells.length, "the ruled line must not weld the row").toBe(5);
  });

  /**
   * ONE wide creature is not a ruled line either, and contiguity alone cannot
   * say so — a horizontal quadruped's back IS one unbroken run.
   *
   * This is not hypothetical: intake FRAMES it that way. `reframeSubject` scales
   * a wide subject to `SUBJECT_W_MAX` (0.75), which sits above `RULE_FILL`
   * (0.70), so a maximally-framed wide creature had its body erased by
   * construction. The hound's own idle sliced 2 rows / 3 cells and `intake-qa`
   * called a clean single-blob figure "more than one figure".
   *
   * What still separates them is THICKNESS: a rule is a line in both axes.
   */
  it("keeps ONE creature that is wider than the rule threshold", () => {
    // A body 300/400 = 75% wide (over RULE_FILL) and 60px tall, plus four legs
    // — the hound's proportions, and the shape the reframe produces.
    const data = build((set) => {
      for (let x = 50; x < 350; x++) for (let y = 20; y < 80; y++) set(x, y);
      for (const lx of [70, 120, 280, 330])
        for (let x = lx; x < lx + 14; x++) for (let y = 80; y < 100; y++) set(x, y);
    });
    const rows = sliceSheet(data, W, H);
    expect(rows.length, "the body was erased as a border and split the creature").toBe(1);
    expect(rows[0].cells.length, "one creature is one cell").toBe(1);
    const [, y0, , y1] = rows[0].cells[0];
    expect(y1 - y0 + 1, "the creature lost its body rows").toBeGreaterThanOrEqual(75);
  });

  it("ANTI-VACUITY: a full-width rule THROUGH that creature is still stripped", () => {
    // Same animal, plus a genuine 2px rule above it. Thickness is what tells
    // them apart, so the thin one must still go.
    const data = build((set) => {
      for (let x = 50; x < 350; x++) for (let y = 20; y < 80; y++) set(x, y);
      for (let x = 0; x < W; x++) { set(x, 8); set(x, 9); }
    });
    const rows = sliceSheet(data, W, H);
    expect(rows.length, "the 2px rule survived as its own band").toBe(1);
    const [, y0] = rows[0].cells[0];
    expect(y0, "the band starts at the rule, not at the creature").toBeGreaterThanOrEqual(15);
  });
});
