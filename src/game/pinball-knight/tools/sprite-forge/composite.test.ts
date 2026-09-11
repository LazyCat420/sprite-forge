import { describe, it, expect } from "vitest";
import { blendPixel, extractCell, compositeSheet, type CompositeConfig } from "./composite";

describe("Composite Forge: Multi-Part Assembly Tool", () => {
  it("correctly blends source pixel over destination with alpha", () => {
    const dst = new Uint8ClampedArray(4); // initially transparent black [0, 0, 0, 0]
    blendPixel(dst, 0, 255, 0, 0, 255); // Full red over transparent
    expect(dst[0]).toBe(255);
    expect(dst[1]).toBe(0);
    expect(dst[2]).toBe(0);
    expect(dst[3]).toBe(255);

    // Blend semi-transparent blue (alpha = 128) over red
    blendPixel(dst, 0, 0, 0, 255, 128);
    expect(dst[3]).toBe(255);
    expect(dst[0]).toBeLessThan(255); // Red diminished
    expect(dst[2]).toBeGreaterThan(0); // Blue mixed in
  });

  it("extracts sub-grid cell cleanly from a composite sheet", () => {
    // 2x2 grid, each cell 2x2 pixels -> total 4x4 image
    const srcW = 4;
    const srcH = 4;
    const src = new Uint8ClampedArray(srcW * srcH * 4);

    // Color cell (col=1, row=0) green
    // Top right 2x2 area: x in [2, 3], y in [0, 1]
    for (let y = 0; y < 2; y++) {
      for (let x = 2; x < 4; x++) {
        const i = (y * srcW + x) * 4;
        src[i] = 0;
        src[i + 1] = 255;
        src[i + 2] = 0;
        src[i + 3] = 255;
      }
    }

    const cell = extractCell(src, srcW, srcH, 1, 0, 2, 2);
    expect(cell.width).toBe(2);
    expect(cell.height).toBe(2);

    for (let p = 0; p < cell.width * cell.height; p++) {
      expect(cell.data[p * 4 + 1]).toBe(255); // Green channel
      expect(cell.data[p * 4 + 3]).toBe(255); // Alpha
    }
  });

  it("composites multiple part layers in ascending z-order onto target grid", () => {
    // 2 layers: Body (z=10, Red) and Head/Wings (z=20, Blue on top)
    const partW = 4;
    const partH = 4;

    const bodyData = new Uint8ClampedArray(partW * partH * 4);
    // Fill body red
    for (let i = 0; i < partW * partH; i++) {
      bodyData[i * 4] = 255;
      bodyData[i * 4 + 3] = 255;
    }

    const headData = new Uint8ClampedArray(partW * partH * 4);
    // Fill head blue
    for (let i = 0; i < partW * partH; i++) {
      headData[i * 4 + 2] = 255;
      headData[i * 4 + 3] = 255;
    }

    const config: CompositeConfig = {
      id: "dragon-boss",
      grid: [2, 2],
      cellSize: [2, 2],
      layers: [
        {
          name: "head",
          image: { width: partW, height: partH, data: headData },
          sourceGrid: [2, 2],
          zIndex: 20,
        },
        {
          name: "body",
          image: { width: partW, height: partH, data: bodyData },
          sourceGrid: [2, 2],
          zIndex: 10,
        },
      ],
    };

    const result = compositeSheet(config);
    expect(result.width).toBe(4);
    expect(result.height).toBe(4);

    // Because head (blue) has higher zIndex than body (red), top layer must be blue
    for (let i = 0; i < result.width * result.height; i++) {
      expect(result.data[i * 4 + 2], "Head blue layer is on top").toBe(255);
      expect(result.data[i * 4 + 3], "Full alpha").toBe(255);
    }
  });
});
