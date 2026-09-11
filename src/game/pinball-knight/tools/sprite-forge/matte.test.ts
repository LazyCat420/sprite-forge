/**
 * MATTING — can a generated sheet's opaque field be removed without eating art?
 *
 * The end-to-end test at the bottom is the one that matters: an opaque sheet is
 * exactly what an image generator hands you, and until this stage existed it
 * sliced to a single cell and was rejected before anything else ran.
 */
import { describe, it, expect } from "vitest";
import { estimateBackground, matte, colourDist, rgbHex } from "./matte";
import { sliceSheet } from "./slice";
import { buildSheet, shapeOf } from "./fixtures";

const RAGGED = [4, 6, 4, 2, 3];
const CREAM: [number, number, number] = [240, 237, 230];

/** Opaque pixels whose colour is within `tol` of the field. */
function lightPixels(data: Uint8ClampedArray, tol = 12): number {
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    if (colourDist(data[i], data[i + 1], data[i + 2], CREAM[0], CREAM[1], CREAM[2]) <= tol) n++;
  }
  return n;
}

describe("estimateBackground", () => {
  it("finds the field colour", () => {
    const { data, w, h } = buildSheet({ rows: RAGGED, opaqueBg: CREAM });
    const { bg, confidence } = estimateBackground(data, w, h);
    expect(rgbHex(bg)).toBe(rgbHex(CREAM));
    expect(confidence).toBeGreaterThan(0.9);
  });

  it("is not fooled by a frame in every corner", () => {
    // A corner sample — the usual shortcut — reads the FRAME here and keys the
    // border colour, leaving the whole field opaque. The ring, taken modally,
    // outvotes it: a frame is a few hundred pixels of a ring thousands long.
    const { data, w, h } = buildSheet({ rows: RAGGED, opaqueBg: CREAM, sheetFrame: true });
    expect(rgbHex(estimateBackground(data, w, h).bg)).toBe(rgbHex(CREAM));
  });
});

describe("matte", () => {
  it("removes the field", () => {
    const { data, w, h } = buildSheet({ rows: RAGGED, opaqueBg: CREAM });
    const { report } = matte(data, w, h);
    expect(report.failures).toEqual([]);
    expect(report.keyedPct).toBeGreaterThan(0.5);
  });

  it("KEEPS field-coloured art that is walled in by the silhouette", () => {
    // THE PROPERTY THE WHOLE STAGE EXISTS FOR. The clown's ruff, gloves, face
    // and stripes are white on a cream field; a global "remove everything near
    // the background colour" key punches holes through every one of them. A
    // border fill cannot reach them, so they survive with no tuning.
    const clear = buildSheet({ rows: RAGGED, interiorLight: true });
    const opaque = buildSheet({ rows: RAGGED, opaqueBg: CREAM, interiorLight: true });

    const before = lightPixels(clear.data);
    expect(before).toBeGreaterThan(0); // the fixture really does draw them

    const { data } = matte(opaque.data, opaque.w, opaque.h);
    expect(lightPixels(data)).toBe(before);
  });

  it("reports enclosed pockets instead of guessing", () => {
    const { data, w, h } = buildSheet({ rows: RAGGED, opaqueBg: CREAM, interiorLight: true });
    const { report } = matte(data, w, h);
    // One per figure. They are NOT keyed: a spring's inside should be, a glove
    // must not be, and nothing in the pixels tells them apart.
    expect(report.enclosed.length).toBe(RAGGED.reduce((a, b) => a + b, 0));
    expect(report.warnings.join(" ")).toContain("enclosed");
  });

  it("keys a pocket when the recipe names it", () => {
    const { data, w, h } = buildSheet({ rows: RAGGED, opaqueBg: CREAM, interiorLight: true });
    const first = matte(data, w, h).report.enclosed[0];
    const { report } = matte(data, w, h, { keyEnclosed: [first.seed] });
    expect(report.enclosed.length).toBe(RAGGED.reduce((a, b) => a + b, 0) - 1);
  });

  it("refuses a gradient background rather than keying half of it", () => {
    // Half-keyed is the dangerous outcome, not a harmless one: whatever the
    // fill cannot reach survives as a speckle mesh that welds every cell.
    const { data, w, h } = buildSheet({ rows: RAGGED, opaqueBg: CREAM, gradientBg: true });
    const { report } = matte(data, w, h);
    expect(report.failures.join(" ")).toContain("of the border is within tolerance");
  });

  it("raises its own tolerance for a checkerboarded background", () => {
    // What both real sheets arrive with: a faint transparency checker baked in.
    // A fixed tolerance leaves the darker squares behind; the tolerance is
    // measured from the sheet instead.
    const { data, w, h } = buildSheet({ rows: RAGGED, opaqueBg: CREAM, checkerBg: 9 });
    const { report } = matte(data, w, h);
    expect(report.failures).toEqual([]);
    expect(report.bgConfidence).toBeGreaterThan(0.95);
  });

  it("refuses a sheet that is already transparent", () => {
    const { data, w, h } = buildSheet({ rows: RAGGED });
    const { report } = matte(data, w, h, { bg: CREAM });
    expect(report.failures.join(" ")).toContain("already transparent");
  });
});

describe("matte → slice, end to end", () => {
  it("an opaque generated sheet slices to its true cell counts", () => {
    // Before this stage existed, the SAME input sliced to one cell and the run
    // aborted with "is the background transparent?".
    const { data, w, h } = buildSheet({ rows: RAGGED, opaqueBg: CREAM, interiorLight: true });
    expect(sliceSheet(data, w, h).flatMap((r) => r.cells).length).toBeLessThanOrEqual(1);

    const keyed = matte(data, w, h).data;
    expect(shapeOf(sliceSheet(keyed, w, h))).toBe(RAGGED.join("/"));
  });

  it("survives a ruled sheet with a frame, captions and an indented row", () => {
    const { data, w, h } = buildSheet({
      rows: RAGGED, opaqueBg: CREAM, ruled: true, sheetFrame: true,
      captions: true, indentRow: 3, interiorLight: true,
    });
    const keyed = matte(data, w, h).data;
    expect(shapeOf(sliceSheet(keyed, w, h))).toBe(RAGGED.join("/"));
  });
});
