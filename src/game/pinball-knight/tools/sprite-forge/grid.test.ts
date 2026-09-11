/**
 * The gate has to be able to FAIL, and it has to fail on the right thing.
 *
 * A detector that says "gridded" for everything would sail through a suite that
 * only ever feeds it good input, and the shipped jester sheet — which has no
 * grid at all — would have been declared 1:1 capable. So the cases below run
 * both arms: synthetic ×N pixel art must be detected AT N, and synthetic
 * continuous art must be REJECTED.
 */
import { describe, it, expect } from "vitest";
import { detectPixelGrid, blockReduce, GRID_CONFIDENCE, type RawImage } from "./grid";
import { ART_BOX, oneToOneScale, fitsArtBox } from "./manifest";
import { RUNGS } from "../../testkit/atlas-census";
import type { Cell } from "./slice";

const W = 96;

function blank(w = W, h = W): RawImage {
  return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
}
function put(img: RawImage, x: number, y: number, r: number, g: number, b: number, a = 255): void {
  const i = (y * img.width + x) * 4;
  img.data[i] = r;
  img.data[i + 1] = g;
  img.data[i + 2] = b;
  img.data[i + 3] = a;
}

/** Pixel art authored at `W/n` logical pixels and upscaled ×n — hard blocks. */
function gridded(n: number): RawImage {
  const img = blank();
  const L = Math.floor(W / n);
  for (let py = 0; py < L; py++) {
    for (let px = 0; px < L; px++) {
      // A deterministic but non-uniform pattern; flat within each block.
      const v = ((px * 37 + py * 91) % 6) * 42;
      for (let by = 0; by < n; by++) {
        for (let bx = 0; bx < n; bx++) put(img, px * n + bx, py * n + by, v, (v * 3) % 255, (v * 7) % 255);
      }
    }
  }
  return img;
}

/** Continuous art: a smooth gradient plus noise — what a generator produces. */
function continuous(): RawImage {
  const img = blank();
  let seed = 7;
  const rnd = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const g = (x / W) * 200 + rnd() * 55;
      put(img, x, y, g, 255 - g, (g * 2) % 255);
    }
  }
  return img;
}

const BOX = [0, 0, W - 1, W - 1] as const;

describe("pixel-grid detection", () => {
  for (const n of [4, 6, 8]) {
    it(`finds the ×${n} lattice in art upscaled ×${n}`, () => {
      const r = detectPixelGrid(gridded(n), [BOX]);
      expect(r.gridded, r.verdict).toBe(true);
      // The LARGEST passing factor, not a divisor of it: a x8 sheet is also
      // perfectly aligned to 2 and 4, and reducing by 4 would leave the art at
      // twice its authored resolution.
      expect(r.factor).toBe(n);
      expect(r.confidence).toBeGreaterThanOrEqual(GRID_CONFIDENCE);
    });
  }

  it("REJECTS continuous art — this is the case the real sheets hit", () => {
    const r = detectPixelGrid(continuous(), [BOX]);
    expect(r.gridded, r.verdict).toBe(false);
    expect(r.factor).toBe(1);
    expect(r.verdict).toMatch(/NOT PIXEL ART/);
  });

  it("does not mistake a smooth gradient for a lattice at any factor", () => {
    // The anti-vacuity case for the one above: assert the whole score curve is
    // low, so a future threshold change cannot quietly let this through.
    const r = detectPixelGrid(continuous(), [BOX]);
    expect(Math.max(...r.scores.map((s) => s.confidence))).toBeLessThan(GRID_CONFIDENCE);
  });
});

describe("cell purity", () => {
  // The metric taken from Sprite Fusion's Pixel Snapper. It exists because a
  // grid DETECTOR can be confident about a step size on art that has no grid —
  // measured, that tool reports step 5.0 at 0.79 spacing regularity on the
  // shipped jester, whose blocks are 6.8% pure. Purity is the check that
  // catches it, so both arms are asserted here.
  it("is ~1 on true pixel art at its own factor", () => {
    for (const n of [4, 6, 8]) {
      const r = detectPixelGrid(gridded(n), [BOX]);
      expect(r.purityFactor, `x${n}`).toBe(n);
      expect(r.cellPurity, `x${n} purity ${r.cellPurity}`).toBeGreaterThan(0.99);
    }
  });

  it("collapses on continuous art — the case a peak detector gets wrong", () => {
    const r = detectPixelGrid(continuous(), [BOX]);
    expect(r.gridded).toBe(false);
    expect(r.cellPurity, `purity ${r.cellPurity}`).toBeLessThan(0.3);
    expect(r.verdict).toMatch(/Cell purity/);
  });

  it("ANTI-VACUITY: purity separates the two by a wide margin", () => {
    // Without this the thresholds above could both pass on a metric that is
    // simply small everywhere, or large everywhere.
    const good = detectPixelGrid(gridded(8), [BOX]).cellPurity;
    const bad = detectPixelGrid(continuous(), [BOX]).cellPurity;
    expect(good - bad).toBeGreaterThan(0.6);
  });
});

describe("block reduce", () => {
  it("is EXACT on true pixel art — reducing ×n recovers the authored pixels", () => {
    const n = 6;
    const src = gridded(n);
    const out = blockReduce(src, n);
    expect(out.width).toBe(W / n);
    for (let y = 0; y < out.height; y++) {
      for (let x = 0; x < out.width; x++) {
        const o = (y * out.width + x) * 4;
        const s = (y * n * src.width + x * n) * 4; // the block's own top-left
        expect([out.data[o], out.data[o + 1], out.data[o + 2]]).toEqual([
          src.data[s], src.data[s + 1], src.data[s + 2],
        ]);
      }
    }
  });

  it("keeps the intended colour when a block has a stray pixel", () => {
    // Majority, not average: an average would invent a colour that is in
    // neither the block's fill nor its stray, and the palette snap would then
    // have to guess which one it meant.
    const n = 4;
    const src = gridded(n);
    const o0 = (0 * src.width + 0) * 4;
    const fill = [src.data[o0], src.data[o0 + 1], src.data[o0 + 2]];
    put(src, 1, 1, 255, 255, 255); // one stray in a 4x4 block
    const out = blockReduce(src, n);
    expect([out.data[0], out.data[1], out.data[2]]).toEqual(fill);
  });
});

describe("the 1:1 scale", () => {
  // `texels = cellPx × k × atlasGrid / ART_BOX` is the chain the runtime walks
  // (art units → device px in the paint buffer → the 2:1 crush). Substituting
  // oneToOneScale must cancel everything except the block count.
  const texelsFor = (cellPx: number, k: number, atlasGrid: number): number =>
    (cellPx * k * atlasGrid) / ART_BOX;

  for (const grid of RUNGS) {
    for (const n of [4, 6, 8]) {
      it(`puts one authored pixel on one texel — ×${n} art at atlas ${grid}`, () => {
        const k = oneToOneScale(n, grid);
        // A cell that is L blocks tall must occupy exactly L texels, at EVERY
        // rung — which is the property `artScale` could never have, because it
        // fits a bounding box instead of deriving from the lattice.
        for (const L of [12, 27, 48]) {
          expect(texelsFor(L * n, k, grid)).toBeCloseTo(L, 9);
        }
      });
    }
  }

  it("REFUSES to shrink a sheet that is too big — 1:1 is not negotiable", () => {
    // A x8 sheet whose figure is 40 blocks tall needs 40 of the 63 texels: fine.
    // The same art at x4 would need 80, which cannot fit — and the honest answer
    // is to re-author it, not to scale it down and lose the property silently.
    const cells = [[0, 0, 8 * 30 - 1, 8 * 40 - 1]] as const;
    expect(fitsArtBox(cells as unknown as Cell[], oneToOneScale(8, 63))).toBe(true);
    expect(fitsArtBox(cells as unknown as Cell[], oneToOneScale(4, 63))).toBe(false);
  });
});
