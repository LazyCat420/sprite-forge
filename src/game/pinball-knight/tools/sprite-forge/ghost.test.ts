/**
 * THREE HALVES, and the third one is the one that could embarrass us.
 *
 * 1. SYNTHETIC — dissolve a limb on purpose and prove the metric moves, and
 *    prove each half of the conjunction is load-bearing (a flat-but-solid
 *    region must NOT fire, or this gate would condemn pixel art by definition).
 * 2. NEGATIVE — every published sheet must score clean. A gate that condemns
 *    shipped art has happened in this repo before.
 * 3. REAL POSITIVE — the dog walk that motivated the file. Its frames live
 *    under `work/`, which is gitignored, so this half SKIPS when they are
 *    absent rather than pretending to have run. When it does run it asserts the
 *    exact frames a human picked out of the contact sheet by eye.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT CLAIM ───────────────────────────────────
 * A pass here does not mean the gate is right, only that it is not insane on
 * the two clips and seven sheets it has seen. `ghost.ts` documents the one
 * domain where it is nearly inert (post-matte art) instead of hiding it.
 */
import { describe, it, expect } from "vitest";
import { loadImage, createCanvas } from "canvas";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ghostScore, ghostClip, GHOST } from "./ghost";
import type { RawImage } from "./resample";

const PUBLIC = join(__dirname, "..", "..", "..", "..", "..", "public", "sprites");
/** The A/B pair. Same seed, same master, same prompt, same 640² canvas — the
 *  ONLY difference is `temporal_size` 8 vs 24 on VAEDecodeTiled. */
const DOG = join(__dirname, "work", "comfy", "animate-walk-2026-08-07T20-46-28");
const DOG_FIXED = join(__dirname, "work", "comfy", "animate-walk-2026-08-07T21-49-40");

async function png(path: string): Promise<RawImage> {
  const img = await loadImage(path);
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, img.width, img.height);
  return { width: img.width, height: img.height, data: d.data as unknown as Uint8ClampedArray };
}

// ── synthetic ───────────────────────────────────────────────────────────────

/**
 * A textured body on a white field, with one leg drawn at `strength`.
 *
 * strength 1 is a solid leg. Below 1 the leg is mixed toward the field AND its
 * texture is removed, which is what a cross-faded decode produces — both
 * changes together, because either alone is not the defect.
 */
function frame(strength: number, opts: { field?: [number, number, number]; flatBody?: boolean } = {}): RawImage {
  const w = 128, h = 128;
  const [fr, fg, fb] = opts.field ?? [255, 255, 255];
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = fr; data[i * 4 + 1] = fg; data[i * 4 + 2] = fb; data[i * 4 + 3] = 255;
  }
  const put = (x: number, y: number, v: number) => {
    const i = (y * w + x) * 4;
    data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
  };
  // body: dark and TEXTURED, so the frame has a real detail baseline
  for (let y = 30; y < 80; y++) {
    for (let x = 40; x < 90; x++) put(x, y, opts.flatBody ? 30 : ((x + y) % 3) * 24);
  }
  // leg: mixed toward the field by (1 - strength), and flat
  const ink = 30;
  const mix = (a: number, b: number) => Math.round(a * strength + b * (1 - strength));
  for (let y = 80; y < 118; y++) {
    for (let x = 55; x < 72; x++) {
      const i = (y * w + x) * 4;
      data[i] = mix(ink, fr); data[i + 1] = mix(ink, fg); data[i + 2] = mix(ink, fb); data[i + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

describe("ghostScore — responds to a dissolved limb and to nothing else", () => {
  it("scores a solid figure near zero", () => {
    expect(ghostScore(frame(1)).pct).toBeLessThan(GHOST.SOFT_TOL);
  });

  it("fires once the limb is mixed most of the way to the field", () => {
    expect(ghostScore(frame(0.3)).pct).toBeGreaterThan(GHOST.TOL);
  });

  it("is a STEP, not a ramp — and that is the honest description", () => {
    // Worth pinning because it is the metric's real shape and a reader would
    // otherwise assume a gradient. `washed` is a threshold: once a limb is more
    // than halfway to the field, ALL of it counts, so the score jumps and then
    // saturates rather than climbing. It measures HOW MUCH of the figure
    // dissolved, not how far.
    const solid = ghostScore(frame(1)).pct;
    const barely = ghostScore(frame(0.7)).pct;
    const half = ghostScore(frame(0.45)).pct;
    const gone = ghostScore(frame(0.2)).pct;
    expect(solid).toBeLessThan(GHOST.SOFT_TOL);
    expect(barely).toBeLessThan(GHOST.SOFT_TOL);   // still solid enough to read as ink
    expect(half).toBeGreaterThan(GHOST.TOL);
    expect(gone).toBeGreaterThan(GHOST.TOL);
    expect(Math.abs(gone - half)).toBeLessThan(0.01); // saturated
  });

  it("does NOT fire on a flat body that is fully opaque — flat alone is not the defect", () => {
    // This is the check that keeps the gate off pixel art, which is flat by
    // construction. If this ever fails, the `washed` term has stopped
    // load-bearing and the gate will start condemning the art it exists for.
    expect(ghostScore(frame(1, { flatBody: true })).pct).toBeLessThan(GHOST.SOFT_TOL);
  });

  it("reads a magenta field as readily as a white one", () => {
    const white = ghostScore(frame(0.3)).pct;
    const magenta = ghostScore(frame(0.3, { field: [255, 0, 255] })).pct;
    expect(magenta).toBeGreaterThan(GHOST.TOL);
    expect(Math.abs(magenta - white)).toBeLessThan(0.02);
  });
});

describe("ghostClip — names the frames to drop", () => {
  it("flags the dissolved frames and passes the rest", () => {
    const frames = [1, 1, 0.25, 1, 1, 1, 0.3, 1].map((s) => frame(s));
    const v = ghostClip(frames, { label: "synthetic walk" });
    expect(v.flagged).toEqual([2, 6]);
    expect(v.level).toBe("reject");
    expect(v.report).toContain("ghost% per frame");
  });

  it("passes a clip with no dissolved frames", () => {
    const v = ghostClip([1, 1, 1, 1].map((s) => frame(s)));
    expect(v.flagged).toEqual([]);
    expect(v.level).toBe("ready");
  });

  it("says NOTHING about a uniformly clean clip, however tight its spread", () => {
    // REGRESSION, and it was found by the experiment rather than by reading:
    // the decode A/B returned 21 frames between 0.09% and 0.23%, a clip with no
    // ghosting anywhere. The MAD of a series that flat is ~0.01%, so
    // `median + 3*MAD` sat at 0.14% and the relative rule flagged the three
    // frames above it. An outlier test on a clean population finds noise and
    // calls it signal; GHOST.FLOOR is what stops it.
    const frames = [1, 1, 1, 1, 1, 1, 1, 1].map((s, i) =>
      // Vary each frame slightly so the MAD is small but non-zero, which is the
      // shape that broke it. An identical-frames fixture would not reproduce.
      frame(s - i * 0.001),
    );
    const v = ghostClip(frames);
    expect(Math.max(...v.pct)).toBeLessThan(GHOST.FLOOR);
    expect(v.flagged).toEqual([]);
    expect(v.soft).toEqual([]);
    expect(v.level).toBe("ready");
  });

  it("still rejects a clip that is UNIFORMLY ghosted, where there are no outliers", () => {
    // The relative rule alone would pass this: every frame is equally bad, so
    // the MAD is ~0 and nothing is an outlier. The absolute floor is what
    // catches it, and this is the case that makes both rules necessary.
    const v = ghostClip([0.25, 0.25, 0.25, 0.25].map((s) => frame(s)));
    expect(v.flagged.length).toBe(4);
    expect(v.level).toBe("reject");
  });
});

// ── negative control: shipped art ───────────────────────────────────────────

describe("ghostScore — does not condemn published sheets", () => {
  const sheets = existsSync(PUBLIC) ? readdirSync(PUBLIC).filter((f) => f.endsWith(".png")) : [];

  it("finds published sheets to score", () => {
    expect(sheets.length).toBeGreaterThan(0);
  });

  for (const f of sheets) {
    it(`${f} scores clean`, async () => {
      const s = ghostScore(await png(join(PUBLIC, f)));
      expect(s.pct).toBeLessThan(GHOST.SOFT_TOL);
    });
  }
});

// ── real positive control: the clip this file exists for ────────────────────

describe("ghostClip — the dog walk of 2026-08-07", () => {
  const present = existsSync(DOG);
  const t = present ? it : it.skip;

  t("flags every decode seam, and nothing furthest from one", async () => {
    const files = readdirSync(DOG).filter((f) => f.endsWith(".png")).sort();
    const frames = await Promise.all(files.map((f) => png(join(DOG, f))));
    const v = ghostClip(frames, { label: "dog walk" });
    expect(v.level).toBe("reject");

    // THE MECHANISM, as a falsifiable pair of claims. `VAEDecodeTiled` ran at
    // temporal_size 8 / overlap 4, so its windows meet at output frames 4, 8,
    // 12 and 16, and frames at i%4===3 sit furthest from any of them. If the
    // ghosting were the model's own motion blur there would be no reason for
    // it to respect that arithmetic. See docs/PLAN_DOG_WALK.md §1.
    for (const seam of [4, 8, 12, 16]) expect(v.flagged).toContain(seam);
    for (const far of [3, 7, 11, 15, 19]) expect(v.flagged).not.toContain(far);

    // The gate flags a SUPERSET of what the eye picked (4, 12, 16 were
    // obvious in the contact sheet; 5, 13, 14 are the seams' neighbours and
    // are mildly smeared). Over-dropping is the right error here: a 21-frame
    // clip only needs 8 keys, and one morphing frame ruins the loop.
    expect(v.flagged).toEqual([4, 5, 8, 12, 13, 14, 16]);
  });

  t("leaves the clean frames well under the floor", async () => {
    const files = readdirSync(DOG).filter((f) => f.endsWith(".png")).sort();
    const frames = await Promise.all(files.map((f) => png(join(DOG, f))));
    const v = ghostClip(frames);
    const clean = v.pct.filter((_, i) => !v.flagged.includes(i) && !v.soft.includes(i));
    expect(Math.max(...clean)).toBeLessThan(GHOST.SOFT_TOL);
  });

  const both = existsSync(DOG) && existsSync(DOG_FIXED);
  const tb = both ? it : it.skip;

  tb("the SAME clip decoded in one temporal window is clean end to end", async () => {
    // THE EXPERIMENT, pinned. One variable — temporal_size 8 → 24 — and the
    // worst frame goes 10.43% → 0.23%, with nothing flagged. If a future change
    // to the metric cannot still tell these two clips apart, the metric has
    // stopped measuring the thing it was built for.
    const load = async (d: string) =>
      ghostClip(await Promise.all(readdirSync(d).filter((f) => f.endsWith(".png")).sort().map((f) => png(join(d, f)))));
    const seamed = await load(DOG);
    const whole = await load(DOG_FIXED);

    expect(whole.flagged).toEqual([]);
    expect(whole.soft).toEqual([]);
    expect(whole.level).toBe("ready");
    // The clean clip's WORST frame is below the seamed clip's BEST — the two
    // populations do not overlap at all.
    expect(Math.max(...whole.pct)).toBeLessThan(Math.min(...seamed.pct.filter((_, i) => seamed.flagged.includes(i))));
    expect(Math.max(...whole.pct)).toBeLessThan(GHOST.FLOOR);
  });
});
