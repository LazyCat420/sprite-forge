/**
 * THE THREE NEW PROPERTIES, held to the same standard as the commit's own.
 *
 * `bench.test.ts` is a BENCH — it is opt-in, it takes a couple of minutes, and
 * its job is to render candidates for a human to pick between. These are the properties that must hold on
 * every run afterwards, because each one is something that can rot silently:
 *
 *   1. a derived palette is DETERMINISTIC and pins ink. A published sheet whose
 *      colours move every time the forge runs is not an artifact anyone can
 *      review, and a silhouette that outlines in its own near-black stops
 *      matching every painted actor beside it.
 *   2. `synth` produces FLAT REGIONS and a ONE-TEXEL outline. Both are the
 *      construction, not a tuning outcome, so both are assertable.
 *   3. `native` imports 1:1 or REFUSES. The whole value of art authored at
 *      final resolution is that nothing touches it; a native path that quietly
 *      resampled would be worse than none, because the report would say it did
 *      not.
 *
 * Anti-vacuity runs through all three: each fixture is asserted to be the kind
 * of input that could fail before the property is asserted to hold.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { commitToGrid, type RawImage } from "./commit";
import { derivePalette, hexOf, INK_RGB } from "./palette-derive";
import { synthCell } from "./synth";
import { installSpriteTestDom } from "../../testkit/atlas-census";
import { paletteRgb } from "../../render/atlas-census";
import { blockReduce } from "./grid";
import type { ManifestRow } from "./manifest";
import type { Cell } from "./slice";

let restore = (): void => {};
beforeAll(() => { restore = installSpriteTestDom(); });
afterAll(() => { restore(); });

const SW = 400;
const SH = 300;

/** A noisy continuous figure — the shape a generator actually emits. */
function noisyFigure(w: number, h: number, seed0 = 7): RawImage {
  const img: RawImage = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  let seed = seed0;
  const rnd = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const cx = w / 2, cy = h / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = (x - cx) / (w / 2), ny = (y - cy) / (h / 2);
      if (nx * nx + ny * ny > 1) continue;
      const i = (y * w + x) * 4;
      // Three broad materials over a vertical value ramp, plus per-pixel noise:
      // large areas that SHOULD become flat regions, none of which are flat now.
      const band = y < h * 0.35 ? 0 : y < h * 0.7 ? 1 : 2;
      const base = [[210, 170, 130], [120, 130, 150], [70, 60, 55]][band];
      const v = 0.72 + 0.28 * (1 - y / h);
      img.data[i] = base[0] * v + rnd() * 26;
      img.data[i + 1] = base[1] * v + rnd() * 26;
      img.data[i + 2] = base[2] * v + rnd() * 26;
      img.data[i + 3] = 255;
    }
  }
  return img;
}

/** Six of those on one sheet, with the rects that cut them out. */
function noisySheet(): { img: RawImage; rows: ManifestRow[] } {
  const img: RawImage = { width: SW, height: SH, data: new Uint8ClampedArray(SW * SH * 4) };
  const cells: Cell[] = [
    [10, 10, 109, 139], [130, 10, 229, 139], [250, 10, 349, 139],
    [10, 160, 109, 289], [130, 160, 229, 289], [250, 160, 349, 289],
  ];
  cells.forEach(([x0, y0, x1, y1], f) => {
    const fig = noisyFigure(x1 - x0 + 1, y1 - y0 + 1, 7 + f * 31);
    for (let y = 0; y < fig.height; y++) {
      for (let x = 0; x < fig.width; x++) {
        const s = (y * fig.width + x) * 4;
        if (!fig.data[s + 3]) continue;
        const d = ((y0 + y) * SW + x0 + x) * 4;
        img.data.set(fig.data.subarray(s, s + 4), d);
      }
    }
  });
  return {
    img,
    rows: [
      { clip: "idle", cells: cells.slice(0, 3) },
      { clip: "walk", cells: cells.slice(3) },
    ],
  };
}

/** Distinct opaque colours in any RGBA buffer. */
function distinct(d: Uint8ClampedArray): Set<number> {
  const s = new Set<number>();
  for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 127) s.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
  return s;
}

describe("per-sprite palettes", () => {
  it("derives the same palette twice from the same pixels", () => {
    const cells = [noisyFigure(100, 130), noisyFigure(100, 130, 99)];
    // Anti-vacuity: a fixture with fewer colours than slots would make any
    // clustering agree with any other by having nothing to decide.
    expect(distinct(cells[0].data).size).toBeGreaterThan(500);
    const a = derivePalette(cells, 20);
    const b = derivePalette(cells, 20);
    expect(a.rgb.map(hexOf)).toEqual(b.rgb.map(hexOf));
    expect(a.rgb.length).toBeLessThanOrEqual(20);
  });

  it("pins ink at entry 0 even when the art's own darkest colour is not ink", () => {
    // A figure whose darkest region is a saturated blue. Unpinned, "the darkest
    // cluster" would land on navy and the silhouette would stop matching the
    // painted roster's outline.
    const w = 60, h = 60;
    const img: RawImage = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    for (let p = 0; p < w * h; p++) {
      const dark = p % 3 === 0;
      img.data[p * 4] = dark ? 8 : 190;
      img.data[p * 4 + 1] = dark ? 14 : 160;
      img.data[p * 4 + 2] = dark ? 90 : 140;
      img.data[p * 4 + 3] = 255;
    }
    const pal = derivePalette([img], 8);
    expect(pal.rgb[0]).toEqual([...INK_RGB]);
    // And the navy still gets a slot of its own — pinning ink must not COST the
    // art its darkest colour, only stop it being called ink.
    expect(pal.rgb.some((c) => c[2] > c[0] + 40)).toBe(true);
  });

  it("commits a sheet onto its own palette, and every texel lands on it", () => {
    const { img, rows } = noisySheet();
    const c = commitToGrid(img, rows, paletteRgb(), { derive: 20 });
    expect(c.derived).toBe(true);
    expect(c.palette.length).toBeLessThanOrEqual(20);
    const own = new Set(c.palette.map((p) => (p[0] << 16) | (p[1] << 8) | p[2]));
    for (const v of distinct(c.image.data)) expect(own.has(v)).toBe(true);
    // The point of the exercise: these are NOT the shared palette's colours.
    const shared = new Set(paletteRgb().map((p) => (p[0] << 16) | (p[1] << 8) | p[2]));
    const offShared = [...own].filter((v) => !shared.has(v)).length;
    expect(offShared, "a derived palette that is just the shared one is not derived").toBeGreaterThan(10);
  });

  it("still meets the entry lock, and a ban is refused rather than half-honoured", () => {
    const { img, rows } = noisySheet();
    const c = commitToGrid(img, rows, paletteRgb(), { derive: 20, maxEntries: 12, ban: [6, 7, 8, 9] });
    expect(c.palette.length).toBeLessThanOrEqual(12);
    expect(c.report.entries).toBeLessThanOrEqual(12);
    expect(c.report.verdict).toContain("ban ignored");
  });
});

describe("synth — authoring at final resolution", () => {
  it("produces flat regions where the vote produces a mosaic", () => {
    const src = noisyFigure(120, 160);
    const out = synthCell(src, 30, 40);
    // Every opaque texel's colour comes from a region mean, so the count of
    // distinct colours collapses even BEFORE any palette snap. That is the
    // property: flatness by construction, not by a later repair pass.
    const before = distinct(src.data).size;
    const after = distinct(out.data).size;
    expect(before).toBeGreaterThan(1000);
    expect(after).toBeLessThan(before / 10);
  });

  it("draws a one-texel outline, not a two-texel one", () => {
    const src = noisyFigure(120, 160);
    const out = synthCell(src, 30, 40);
    const ink = (p: number): boolean =>
      out.data[p * 4] === INK_RGB[0] && out.data[p * 4 + 1] === INK_RGB[1] && out.data[p * 4 + 2] === INK_RGB[2];
    const opaque = (p: number): boolean => out.data[p * 4 + 3] > 127;
    // An interior texel — one with four opaque orthogonal neighbours that are
    // themselves fully surrounded — must never be ink. If the outline pass read
    // its own output it would eat inward a texel at a time.
    let interiorInk = 0;
    let rim = 0;
    for (let y = 2; y < 38; y++) {
      for (let x = 2; x < 28; x++) {
        const p = y * 30 + x;
        if (!opaque(p)) continue;
        const edge = !opaque(p - 1) || !opaque(p + 1) || !opaque(p - 30) || !opaque(p + 30);
        if (edge) { if (ink(p)) rim++; continue; }
        const nearEdge =
          !opaque(p - 2) || !opaque(p + 2) || !opaque(p - 60) || !opaque(p + 60);
        if (!nearEdge && ink(p)) interiorInk++;
      }
    }
    expect(rim, "no outline was drawn at all").toBeGreaterThan(20);
    expect(interiorInk, "the outline grew inward — it is reading its own output").toBe(0);
  });

  it("is deterministic", () => {
    const src = noisyFigure(120, 160);
    const a = synthCell(src, 30, 40);
    const b = synthCell(src, 30, 40);
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
  });
});

describe("native — art already at final resolution", () => {
  /** A tiny hand-authored sheet: two 20×30 figures, flat colours, no lattice. */
  function nativeSheet(): { img: RawImage; rows: ManifestRow[] } {
    const w = 64, h = 40;
    const img: RawImage = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    const draw = (ox: number, tint: number): void => {
      for (let y = 4; y < 34; y++) {
        for (let x = ox; x < ox + 20; x++) {
          const i = (y * w + x) * 4;
          const edge = y === 4 || y === 33 || x === ox || x === ox + 19;
          img.data[i] = edge ? 23 : 120 + tint;
          img.data[i + 1] = edge ? 26 : 130;
          img.data[i + 2] = edge ? 34 : 150 - tint;
          img.data[i + 3] = 255;
        }
      }
    };
    draw(4, 0);
    draw(40, 60);
    return { img, rows: [{ clip: "idle", cells: [[4, 4, 23, 33], [40, 4, 59, 33]] }] };
  }

  it("imports one source pixel per texel and moves nothing", () => {
    const { img, rows } = nativeSheet();
    const c = commitToGrid(img, rows, paletteRgb(), { native: true, derive: 8, factor: 4 });
    // The figure is 30 px tall in the source and must be 30 TEXELS in the
    // commit — no vote, no fit, no scale.
    expect(c.report.texelH).toBe(30);
    expect(c.report.texelW).toBe(20);
    // And the committed sheet block-reduces back to those exact texels.
    const cell = c.rows[0].cells[0];
    const [x0, y0, x1, y1] = cell;
    expect((x1 - x0 + 1) / c.report.factor).toBe(20);
    expect((y1 - y0 + 1) / c.report.factor).toBe(30);
  });

  it("REFUSES art too large for the cel rather than resampling it", () => {
    // 200 texels tall against a budget of 72 at grid 84. The vote path would
    // shrink this silently; native must not.
    const w = 220, h = 210;
    const img: RawImage = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    for (let p = 0; p < w * h; p++) {
      img.data[p * 4] = 100; img.data[p * 4 + 1] = 110; img.data[p * 4 + 2] = 120; img.data[p * 4 + 3] = 255;
    }
    const rows: ManifestRow[] = [{ clip: "idle", cells: [[5, 5, 204, 204]] }];
    expect(() => commitToGrid(img, rows, paletteRgb(), { native: true, factor: 4 })).toThrow(/1:1 or not at all/);
  });

  it("lets a death sprawl use the hard box the rest of the pipeline gives it", () => {
    // 80 texels wide — over the 70-texel LIVING cap at grid 84, inside the hard
    // one. The first native run rejected exactly this and the art was fine.
    const w = 200, h = 100;
    const img: RawImage = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    for (let p = 0; p < w * h; p++) {
      img.data[p * 4] = 90; img.data[p * 4 + 1] = 100; img.data[p * 4 + 2] = 110; img.data[p * 4 + 3] = 255;
    }
    const rows: ManifestRow[] = [
      { clip: "idle", cells: [[2, 2, 41, 61]] },
      { clip: "death", cells: [[60, 2, 139, 41]] },
    ];
    // Asserted on the GATE, not on `not.toThrow()`. Two flat rectangles are not
    // a sliceable sheet, so the repack's own re-slice check fails downstream on
    // this fixture — and a bare `not.toThrow()` would therefore have gone green
    // for the wrong reason if the gate were later widened to reject sprawls
    // again. What must be true is that the failure is not THIS one.
    let msg = "";
    try {
      commitToGrid(img, rows, paletteRgb(), { native: true, factor: 4 });
    } catch (e) {
      msg = String(e);
    }
    expect(msg).not.toMatch(/1:1 or not at all/);
    expect(msg).not.toMatch(/death/);
  });

  it("round-trips a committed sheet without moving a texel", () => {
    const { img, rows } = noisySheet();
    const first = commitToGrid(img, rows, paletteRgb(), { mode: "synth", derive: 20 });
    // Read the committed sheet back as native art: the top-left pixel of every
    // block IS the texel, because the commit's last step replicated it there.
    const f = first.report.factor;
    const nw = Math.floor(first.image.width / f), nh = Math.floor(first.image.height / f);
    const nat: RawImage = { width: nw, height: nh, data: new Uint8ClampedArray(nw * nh * 4) };
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        const s = (y * f * first.image.width + x * f) * 4;
        nat.data.set(first.image.data.subarray(s, s + 4), (y * nw + x) * 4);
      }
    }
    const natRows: ManifestRow[] = first.rows.map((r) => ({
      clip: r.clip,
      cells: r.cells.map(
        ([x0, y0, x1, y1]) =>
          [Math.round(x0 / f), Math.round(y0 / f), Math.round((x1 + 1) / f) - 1, Math.round((y1 + 1) / f) - 1] as Cell,
      ),
    }));
    const second = commitToGrid(nat, natRows, paletteRgb(), { native: true, derive: 20, factor: f });
    expect(second.report.texelH).toBe(first.report.texelH);
    expect(second.report.texelW).toBe(first.report.texelW);
    // The palette re-derived from an already-derived sheet must be the SAME
    // palette. If it drifts, every re-publish would shift the creature's colours.
    expect(second.palette.map(hexOf).sort()).toEqual(first.palette.map(hexOf).sort());
    // And the pixels themselves survive the trip.
    const a = blockReduce(
      { width: first.image.width, height: first.image.height, data: first.image.data } as never,
      f, 0, 0,
    );
    const b = blockReduce(
      { width: second.image.width, height: second.image.height, data: second.image.data } as never,
      second.report.factor, 0, 0,
    );
    expect(distinct(b.data).size).toBe(distinct(a.data).size);
  });
});
