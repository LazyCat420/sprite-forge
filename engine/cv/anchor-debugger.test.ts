import { describe, expect, it } from "vitest";
import {
  assertProtectedPixels,
  computeCentroid,
  computeOnionSkinDelta,
  detectSmartParts,
  findGroundBaseline,
  getForegroundBounds,
} from "./anchor-debugger";

describe("sprite-forge anchor-debugger suite", () => {
  const w = 32;
  const h = 32;

  function createBlankCanvas(): Uint8Array {
    return new Uint8Array(w * h * 4);
  }

  function setPixel(buf: Uint8Array, x: number, y: number, r = 255, g = 255, b = 255, a = 255) {
    const idx = (y * w + x) * 4;
    buf[idx] = r;
    buf[idx + 1] = g;
    buf[idx + 2] = b;
    buf[idx + 3] = a;
  }

  function fillRect(buf: Uint8Array, rx: number, ry: number, rw: number, rh: number, r = 200, g = 200, b = 200, a = 255) {
    for (let y = ry; y < ry + rh; y++) {
      for (let x = rx; x < rx + rw; x++) {
        setPixel(buf, x, y, r, g, b, a);
      }
    }
  }

  it("extracts foreground bounds and ground baseline", () => {
    const buf = createBlankCanvas();
    fillRect(buf, 10, 5, 12, 20);

    const bounds = getForegroundBounds(buf, w, h);
    expect(bounds).toEqual({ x: 10, y: 5, w: 12, h: 20 });

    const baseline = findGroundBaseline(buf, w, h);
    expect(baseline).toBe(24);
  });

  it("calculates centroid center of mass", () => {
    const buf = createBlankCanvas();
    fillRect(buf, 10, 10, 10, 10);

    const c = computeCentroid(buf, w, h);
    expect(c.x).toBe(14.5);
    expect(c.y).toBe(14.5);
  });

  it("extracts smart auto-parts (head, torso, feet)", () => {
    const buf = createBlankCanvas();
    fillRect(buf, 10, 4, 12, 20);

    const parts = detectSmartParts(buf, w, h);
    expect(parts.head).toBeDefined();
    expect(parts.head?.y).toBe(4);
    expect(parts.torso?.y).toBeGreaterThan(parts.head?.y!);
    expect(parts.feet?.y).toBeGreaterThan(parts.torso?.y!);
  });

  it("computes onion skin motion delta", () => {
    const frameA = createBlankCanvas();
    const frameB = createBlankCanvas();

    fillRect(frameA, 10, 10, 6, 6, 255, 0, 0);
    fillRect(frameB, 12, 10, 6, 6, 0, 255, 0);

    const delta = computeOnionSkinDelta(frameA, frameB, w, h);
    expect(delta.diffCount).toBeGreaterThan(0);
  });

  it("enforces protected-pixel invariant", () => {
    const original = createBlankCanvas();
    const repaired = createBlankCanvas();
    const mask = createBlankCanvas();

    fillRect(original, 10, 10, 10, 10, 200, 200, 200);
    fillRect(repaired, 10, 10, 10, 10, 200, 200, 200);

    // Inpaint mask over head
    fillRect(mask, 10, 10, 10, 4, 255, 255, 255, 255);
    fillRect(repaired, 10, 10, 10, 4, 255, 0, 0, 255);

    const valid = assertProtectedPixels(original, repaired, mask, w, h);
    expect(valid.valid).toBe(true);

    // Mutate outside pixel
    setPixel(repaired, 10, 18, 0, 0, 0, 255);
    const invalid = assertProtectedPixels(original, repaired, mask, w, h);
    expect(invalid.valid).toBe(false);
    expect(invalid.violatedPixels).toBe(1);
  });
});
