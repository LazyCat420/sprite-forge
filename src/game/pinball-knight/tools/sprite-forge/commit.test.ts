/**
 * The commit has ONE job: turn art that fails the gate into art that passes it,
 * without lying about what it did.
 *
 * So the cases below are adversarial in both directions. The input fixture is
 * deliberately the worst case — continuous, noisy, hundreds of thousands of
 * colours, exactly what `grid.ts` rejected on every real sheet — and the output
 * must satisfy the three properties the rest of the pipeline assumes:
 *
 *   1. `detectPixelGrid` finds the lattice AT the committed factor
 *   2. `blockReduce` recovers the committed texels EXACTLY (that is "1:1")
 *   3. the palette never exceeds the atlas lock, whatever the input contained
 *
 * The anti-vacuity arm matters as much: property 1 is worthless if the fixture
 * would have passed anyway, so the fixture is asserted to FAIL the gate first.
 */
import { describe, it, expect } from "vitest";
import { commitToGrid, MAX_ENTRIES, FIT_GRID, type RawImage } from "./commit";
import { detectPixelGrid, blockReduce } from "./grid";
import { installSpriteTestDom } from "../../testkit/atlas-census";
import { paletteRgb } from "../../render/atlas-census";
import { ART_BOX, ART_FIT_H, oneToOneScale, fitsArtBox } from "./manifest";
import type { ManifestRow } from "./manifest";
import type { Cell } from "./slice";
import { beforeAll, afterAll } from "vitest";

let restore = (): void => {};
beforeAll(() => { restore = installSpriteTestDom(); });
afterAll(() => { restore(); });

const SW = 400;
const SH = 300;

/**
 * A sheet of continuous, noisy figures — a generator's actual output shape.
 *
 * Smooth gradients inside each figure plus per-pixel noise, so nothing is flat
 * and no colour change sits on any lattice. Transparent between figures so the
 * cells are separable.
 */
function generatedSheet(): RawImage {
  const img: RawImage = { width: SW, height: SH, data: new Uint8ClampedArray(SW * SH * 4) };
  let seed = 12345;
  const rnd = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const figures: Cell[] = [
    [10, 10, 109, 139], [130, 10, 229, 139], [250, 10, 349, 139],
    [10, 160, 109, 289], [130, 160, 229, 289], [250, 160, 349, 289],
  ];
  figures.forEach(([x0, y0, x1, y1], f) => {
    const cx = (x0 + x1) / 2;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        // An oval body, so the silhouette has curved (i.e. non-lattice) edges.
        const nx = (x - cx) / ((x1 - x0) / 2);
        const ny = (y - (y0 + y1) / 2) / ((y1 - y0) / 2);
        if (nx * nx + ny * ny > 1) continue;
        // Sweep the full hue circle across the figure AND between figures, over
        // a value ramp — a real creature spends several palette FAMILIES (pelt,
        // steel, brass, glass), and a fixture confined to one ramp would leave
        // the entry lock with nothing to evict and the test vacuous.
        const t = (y - y0) / (y1 - y0);
        const a = f * 1.05 + ((x - x0) / (x1 - x0)) * 3.4;
        // Value spans nearly the whole range, not 0.35-1.0: the palette's ramps
        // run from a near-black void to a near-white flame core, and a fixture
        // that never goes dark or bright cannot reach the entries at either end —
        // which is how it came to bust the 20-lock only under the metric that
        // SCATTERS colours across ramps (see the anti-vacuity test below).
        const v = 0.10 + 0.90 * (1 - t);
        const i = (y * SW + x) * 4;
        img.data[i] = v * (128 + 120 * Math.sin(a)) + rnd() * 22;
        img.data[i + 1] = v * (128 + 120 * Math.sin(a + 2.09)) + rnd() * 22;
        img.data[i + 2] = v * (128 + 120 * Math.sin(a + 4.19)) + rnd() * 22;
        img.data[i + 3] = 255;
      }
    }
  });
  return img;
}

/**
 * Three standing figures over ONE wide flat sprawl — the death-scale case.
 *
 * A separate fixture rather than a re-labelled rect over `generatedSheet`'s
 * ovals: declaring one cell across three drawn figures is not a sprawl, and the
 * re-slice correctly returns three cells, so the test would fail on the fixture
 * rather than on the behaviour.
 */
function sprawlSheet(): RawImage {
  const img: RawImage = { width: SW, height: SH, data: new Uint8ClampedArray(SW * SH * 4) };
  let seed = 999;
  const rnd = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const draw = ([x0, y0, x1, y1]: Cell, f: number): void => {
    const cx = (x0 + x1) / 2;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const nx = (x - cx) / ((x1 - x0) / 2);
        const ny = (y - (y0 + y1) / 2) / ((y1 - y0) / 2);
        if (nx * nx + ny * ny > 1) continue;
        const a = f * 1.05 + ((x - x0) / (x1 - x0)) * 3.4;
        const v = 0.35 + 0.65 * (1 - (y - y0) / (y1 - y0));
        const i = (y * SW + x) * 4;
        img.data[i] = v * (128 + 120 * Math.sin(a)) + rnd() * 22;
        img.data[i + 1] = v * (128 + 120 * Math.sin(a + 2.09)) + rnd() * 22;
        img.data[i + 2] = v * (128 + 120 * Math.sin(a + 4.19)) + rnd() * 22;
        img.data[i + 3] = 255;
      }
    }
  };
  ([[10, 10, 109, 139], [130, 10, 229, 139], [250, 10, 349, 139]] as Cell[]).forEach(draw);
  draw([10, 170, 349, 289], 3); // one connected sprawl: 340 wide, 120 tall
  return img;
}

const SPRAWL_ROWS: ManifestRow[] = [
  { clip: "idle", cells: [[10, 10, 109, 139], [130, 10, 229, 139], [250, 10, 349, 139]] },
  { clip: "death", cells: [[10, 170, 349, 289]] },
];

const ROWS: ManifestRow[] = [
  { clip: "idle", cells: [[10, 10, 109, 139], [130, 10, 229, 139], [250, 10, 349, 139]] },
  { clip: "walk", cells: [[10, 160, 109, 289], [130, 160, 229, 289], [250, 160, 349, 289]] },
];

const PAL = (): number[][] => paletteRgb();

describe("the grid commit", () => {
  it("ANTI-VACUITY: the fixture fails the gate before committing", () => {
    // Without this the whole suite could pass on input that never needed fixing.
    const before = detectPixelGrid(generatedSheet(), ROWS.flatMap((r) => r.cells) as unknown as number[][]);
    expect(before.gridded, before.verdict).toBe(false);
    expect(before.verdict).toMatch(/NOT PIXEL ART/);
  });

  for (const factor of [4, 6, 8]) {
    it(`×${factor}: the committed sheet PASSES the gate at exactly ×${factor}`, () => {
      const r = commitToGrid(generatedSheet(), ROWS, PAL(), { factor });
      const g = detectPixelGrid(r.image, r.rows.flatMap((x) => x.cells) as unknown as number[][]);
      expect(g.gridded, g.verdict).toBe(true);
      expect(g.factor).toBe(factor);
      expect(g.confidence).toBe(1); // synthesised lattice — nothing is off it
    });

    it(`×${factor}: blockReduce recovers the committed texels EXACTLY`, () => {
      // This is the whole definition of a 1:1 import: reducing the sheet by its
      // own factor must return the pixels the commit decided on, not an
      // approximation of them.
      const r = commitToGrid(generatedSheet(), ROWS, PAL(), { factor });
      const red = blockReduce(r.image, factor);
      for (const row of r.rows) {
        for (const [x0, y0, x1, y1] of row.cells) {
          for (let y = y0; y <= y1; y += factor) {
            for (let x = x0; x <= x1; x += factor) {
              const a = (y * r.image.width + x) * 4;
              const b = ((y / factor) * red.width + x / factor) * 4;
              expect([red.data[b], red.data[b + 1], red.data[b + 2], red.data[b + 3]]).toEqual([
                r.image.data[a], r.image.data[a + 1], r.image.data[a + 2], r.image.data[a + 3],
              ]);
            }
          }
        }
      }
    });
  }

  it("holds the atlas entry lock however many colours arrive", () => {
    const r = commitToGrid(generatedSheet(), ROWS, PAL());
    expect(r.report.entries).toBeLessThanOrEqual(MAX_ENTRIES);
  });

  it("ANTI-VACUITY: the lock is doing work — unlocked, this input BUSTS it", () => {
    // Without this, the assertion above would pass on input that happened to
    // land under 20 anyway, and a broken eviction would ship green. Round 2's
    // real sheet censused at 30.7 entries; the fixture has to bust it too or it
    // is not standing in for the problem.
    //
    // ⚠️ THE METRIC CHANGES THIS NUMBER, which is itself the finding. On the
    // pre-2026-08-03 luma snap the old fixture busted the lock easily, because a
    // brightness-only match SCATTERS one material across every ramp that shares
    // its value. Under `oklab` the same input consolidated to 19 entries and this
    // test went vacuous — colours landing on their own ramp is the whole point of
    // the change. The fixture's value range was widened to reach the palette's
    // dark and bright ends so it stands in for a real sheet under BOTH metrics.
    const free = commitToGrid(generatedSheet(), ROWS, PAL(), { maxEntries: 999 });
    expect(free.report.entries).toBeGreaterThan(MAX_ENTRIES);
    expect(free.report.evicted).toBe(0);
  });

  it("a TIGHTER lock evicts more, and says how much it moved", () => {
    // The eviction has to be visible. A commit that silently drops half the
    // sprite's colours and reports success is the failure mode this reports on.
    const loose = commitToGrid(generatedSheet(), ROWS, PAL(), { maxEntries: 20 });
    const tight = commitToGrid(generatedSheet(), ROWS, PAL(), { maxEntries: 6 });
    expect(tight.report.entries).toBeLessThanOrEqual(6);
    expect(tight.report.evicted).toBeGreaterThan(loose.report.evicted);
    expect(tight.report.evictedShare).toBeGreaterThan(loose.report.evictedShare);
    expect(tight.report.verdict).toMatch(/evicted/);
  });

  it("a BANNED family never appears, and its texels land somewhere allowed", () => {
    // The knight measurement (palette-ab, 2026-08-03): the luma-weighted snap
    // sends warm-grey armor onto the rot ramp, and only an explicit ban fixes
    // it. First prove the fixture REACHES the banned entries unbanned — a ban
    // of colours the sheet never used would pass vacuously.
    const pal = PAL();
    const free = commitToGrid(generatedSheet(), ROWS, pal, { maxEntries: 999 });
    const rgbOf = (i: number): number => (pal[i][0] << 16) | (pal[i][1] << 8) | pal[i][2];
    const used = new Set<number>();
    for (let i = 0; i < free.image.data.length; i += 4) {
      if (free.image.data[i + 3] === 0) continue;
      used.add((free.image.data[i] << 16) | (free.image.data[i + 1] << 8) | free.image.data[i + 2]);
    }
    const ban = pal.map((_, i) => i).filter((i) => used.has(rgbOf(i))).slice(0, 3);
    expect(ban.length, "fixture uses too few entries to exercise a ban").toBe(3);

    const banned = commitToGrid(generatedSheet(), ROWS, pal, { maxEntries: 999, ban });
    const banRgb = new Set(ban.map(rgbOf));
    let opaque = 0;
    for (let i = 0; i < banned.image.data.length; i += 4) {
      if (banned.image.data[i + 3] === 0) continue;
      opaque++;
      expect(banRgb.has((banned.image.data[i] << 16) | (banned.image.data[i + 1] << 8) | banned.image.data[i + 2])).toBe(false);
    }
    expect(opaque).toBeGreaterThan(0); // the remap moved texels, not deleted them
    expect(banned.report.verdict).toMatch(/banned entries/);
  });

  it("every committed pixel is an EXACT palette colour", () => {
    // `atlas-census` reports anything else as `unmatched`, and the inbox run
    // asserts that is zero — so an off-palette texel here fails much later and
    // reads as a crush bug.
    const pal = PAL();
    const on = new Set(pal.map(([r, g, b]) => (r << 16) | (g << 8) | b));
    const r = commitToGrid(generatedSheet(), ROWS, pal);
    for (let i = 0; i < r.image.data.length; i += 4) {
      if (r.image.data[i + 3] === 0) continue;
      expect(r.image.data[i + 3]).toBe(255); // alpha is binary, never partial
      expect(on.has((r.image.data[i] << 16) | (r.image.data[i + 1] << 8) | r.image.data[i + 2])).toBe(true);
    }
  });

  it("the committed figure FITS the cel at the 1:1 scale, at FIT_GRID and every closer rung", () => {
    // `FIT_GRID` names the rung the figure is sized to FILL. Since a committed
    // sheet's texel count is rung-independent, it then fits every CLOSER rung
    // for free (same texels, bigger cel) and overflows every wider one.
    //
    // Both halves are asserted. The positive half is the property the import
    // path depends on. The negative half pins the TRADE: `FIT_GRID` is a
    // resolution/coverage dial, and a change that quietly made 72 fit again
    // would mean the figure had been shrunk back to where the player called it
    // a blur. If the ladder or the default rung moves, this list moves.
    const factor = 8;
    const r = commitToGrid(generatedSheet(), ROWS, PAL(), { factor });
    const cells = r.rows.flatMap((x) => x.cells);
    const ladder = [120, 108, 96, 84, 72];
    expect(ladder).toContain(FIT_GRID);
    for (const grid of ladder.filter((g) => g >= FIT_GRID)) {
      const k = oneToOneScale(factor, grid);
      expect(fitsArtBox(cells, k), `overflows the cel at grid ${grid}`).toBe(true);
    }
    for (const grid of ladder.filter((g) => g < FIT_GRID)) {
      const k = oneToOneScale(factor, grid);
      expect(fitsArtBox(cells, k), `unexpectedly fits at grid ${grid} — is the figure too small?`).toBe(false);
    }
    // ...and it is not trivially satisfied by being microscopic.
    expect(r.report.texelH).toBeGreaterThan((ART_FIT_H * FIT_GRID) / ART_BOX / 2);
  });

  it("one authored texel lands on exactly one atlas texel", () => {
    // The arithmetic `oneToOneScale` promises, checked against the committed
    // cell rather than restated: cellPx x k x grid / ART_BOX must be the texel
    // count the commit chose.
    const factor = 8;
    const r = commitToGrid(generatedSheet(), ROWS, PAL(), { factor });
    const [x0, y0, x1, y1] = r.rows[0].cells[0];
    for (const grid of [120, 108, 96, 84, 72]) {
      const k = oneToOneScale(factor, grid);
      expect(((x1 - x0 + 1) * k * grid) / ART_BOX).toBeCloseTo((x1 - x0 + 1) / factor, 9);
      expect(((y1 - y0 + 1) * k * grid) / ART_BOX).toBeCloseTo((y1 - y0 + 1) / factor, 9);
    }
  });

  it("the death sprawl does not shrink the living clips", () => {
    // Same rule as `aliveScale`, and the same failure it was written for: a flat
    // sprawl voting on the scale rendered the walking jester at 58% of its box.
    const withDeath = commitToGrid(sprawlSheet(), SPRAWL_ROWS, PAL());
    const aliveOnly = commitToGrid(sprawlSheet(), [SPRAWL_ROWS[0]], PAL());
    expect(withDeath.report.texelH).toBe(aliveOnly.report.texelH);
    // ...and the sprawl still had to be clamped, or the assertion is vacuous.
    const sprawlCell = withDeath.rows[1].cells[0];
    const aliveCell = withDeath.rows[0].cells[0];
    expect(sprawlCell[2] - sprawlCell[0]).toBeGreaterThan(aliveCell[2] - aliveCell[0]);
  });

  it("keeps the clip names and the cell count", () => {
    const r = commitToGrid(generatedSheet(), ROWS, PAL());
    expect(r.rows.map((x) => x.clip)).toEqual(["idle", "walk"]);
    expect(r.rows.map((x) => x.cells.length)).toEqual([3, 3]);
  });
});
