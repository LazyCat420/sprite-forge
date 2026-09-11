/**
 * THREE HALVES, like `ghost.test.ts`, and the halves are chosen for what they
 * can embarrass:
 *
 * 1. SYNTHETIC — a clip that does not move must REJECT, one that does must
 *    pass, and each of those must survive the other's confound. In particular a
 *    frozen clip with heavy per-frame NOISE must still read as frozen, because
 *    "the pixels changed" and "the creature moved" are not the same claim and
 *    conflating them is how a churn number becomes useless.
 * 2. NEGATIVE — the one approved clip this pipeline has produced must pass.
 *    Unlike ghost's positive fixture this one is COMMITTED (`sources/`, not
 *    `work/`), so it runs on every machine and every CI box. A gate that
 *    condemns the only art we have shipped is the failure mode this repo has
 *    hit twice, and it must not be skippable.
 * 3. REAL POSITIVE — the two frozen clips of 2026-08-08. They live under
 *    `work/`, which is gitignored, so this half SKIPS rather than pretending.
 *
 * ── WHAT A PASS HERE DOES NOT MEAN ──────────────────────────────────────────
 *
 * That the clip is good. This gate answers one question — did anything happen —
 * and deliberately refuses to grade the motion; see `motion.ts`'s header for
 * the measurement that nearly retired `walk4` on exactly that mistake. THE EYE
 * is still the gate.
 */
import { describe, it, expect } from "vitest";
import { loadImage, createCanvas } from "canvas";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { motionClip, churn, figureBox, MOTION } from "./motion";
import type { RawImage } from "./resample";

/** The approved walk — committed, so this fixture is never absent. */
const APPROVED_WALK = join(__dirname, "sources", "dog-2026-08-07");
/** The two frozen clips of 2026-08-08. Under `work/`, therefore gitignored. */
const FROZEN_IDLE = join(__dirname, "work", "comfy", "animate-idle4-2026-08-08T19-49-56");
const FROZEN_RUN = join(__dirname, "work", "comfy", "animate-run4-2026-08-08T19-56-22");

async function png(path: string): Promise<RawImage> {
  const img = await loadImage(path);
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, img.width, img.height);
  return { width: img.width, height: img.height, data: d.data as unknown as Uint8ClampedArray };
}

async function clip(dir: string): Promise<RawImage[]> {
  const names = readdirSync(dir).filter((f) => f.endsWith(".png")).sort();
  return Promise.all(names.map((n) => png(join(dir, n))));
}

// ── synthetic ───────────────────────────────────────────────────────────────

/**
 * A blob on a white field at horizontal offset `dx`, optionally with per-pixel
 * noise. `dx` is the motion; `noise` is the confound.
 */
function frame(dx: number, noise = 0): RawImage {
  const w = 128, h = 128;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = 255; data[i * 4 + 1] = 255; data[i * 4 + 2] = 255; data[i * 4 + 3] = 255;
  }
  // Deterministic pseudo-noise — no Math.random in a test that asserts numbers.
  let seed = 1;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let y = 40; y < 90; y++) {
    for (let x = 40 + dx; x < 80 + dx; x++) {
      if (x < 0 || x >= w) continue;
      const i = (y * w + x) * 4;
      const v = noise ? Math.max(0, Math.min(255, 40 + (rnd() - 0.5) * 2 * noise)) : 40;
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

describe("the freeze detector", () => {
  it("rejects a clip of one repeated frame", () => {
    const v = motionClip(Array.from({ length: 8 }, () => frame(0)));
    expect(v.level).toBe("reject");
    expect(v.checks.find((c) => c.id === "motion")?.pass).toBe(false);
    expect(v.churn.every((c) => c === 0)).toBe(true);
  });

  it("passes a clip whose subject travels", () => {
    const v = motionClip([0, 3, 6, 9, 12, 9, 6, 3].map((dx) => frame(dx)));
    expect(v.level).not.toBe("reject");
    expect(v.checks.find((c) => c.id === "motion")?.pass).toBe(true);
  });

  it("still calls a NOISY still frame frozen — churn is not the claim", () => {
    // The confound that would make this gate worthless: per-pixel jitter with
    // no movement. The figure box is identical in every frame, and a gate that
    // scored raw pixel deltas without the box would call this motion.
    const noisy = Array.from({ length: 8 }, () => frame(0, 8));
    const v = motionClip(noisy);
    expect(v.level).toBe("reject");
  });

  it("measures inside the figure box, not over the canvas", () => {
    // The same two frames scored over the whole canvas vs over the figure. The
    // canvas denominator is ~10x larger here, and it is what makes every clip
    // look like it "barely moved".
    const a = frame(0), b = frame(12);
    const whole = churn(a, b, [0, 0, 127, 127]);
    const figure = churn(a, b, [40, 40, 91, 89]);
    expect(figure).toBeGreaterThan(whole * 3);
  });

  it("refuses to compare frames of different sizes rather than guessing", () => {
    // A cut sheet is not a clip. Silently coercing would produce a number.
    const small: RawImage = { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4) };
    expect(() => churn(frame(0), small, [0, 0, 7, 7])).toThrow(/differ in size/);
  });

  it("finds the ink, not the canvas", () => {
    expect(figureBox(frame(0))).toEqual([40, 40, 79, 89]);
  });
});

// ── the negative: the approved clip must survive ────────────────────────────

describe("the approved dog walk", () => {
  it("passes, and is nowhere near the floor", async () => {
    const frames = await clip(APPROVED_WALK);
    expect(frames.length).toBe(21);
    const v = motionClip(frames, { label: "dog walk" });
    expect(v.level, v.report).toBe("ready");
    // Measured 23.7% median on 2026-08-08. Asserting an order of magnitude of
    // headroom rather than the number itself — the number is a property of that
    // clip, the headroom is the claim the threshold rests on.
    const med = [...v.churn].sort((a, b) => a - b)[v.churn.length >> 1];
    expect(med).toBeGreaterThan(MOTION.FROZEN * 5);
    expect(v.boxes).toBeGreaterThan(frames.length / 2);
  });
});

// ── the real positive: the clips that motivated the file ────────────────────

describe("the frozen clips of 2026-08-08", () => {
  for (const [name, dir] of [["idle4 --loop", FROZEN_IDLE], ["run4 --loop", FROZEN_RUN]] as const) {
    const has = existsSync(dir);
    it.skipIf(!has)(`${name} is caught`, async () => {
      const frames = await clip(dir);
      const v = motionClip(frames, { label: name });
      expect(v.level, v.report).toBe("reject");
      // The whole reason this file exists: ghost scored these `ready`.
      expect(v.report).toMatch(/still photograph/);
    });
  }
});

/**
 * A blob whose SIZE changes — the shrink, synthetically. `scale` 1.0 is the
 * full box; 0.5 halves each side, quartering the area.
 */
function scaledFrame(scale: number): RawImage {
  const w = 128, h = 128;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = 255; data[i * 4 + 1] = 255; data[i * 4 + 2] = 255; data[i * 4 + 3] = 255;
  }
  const bw = Math.round(40 * scale), bh = Math.round(50 * scale);
  const x0 = 64 - (bw >> 1), y0 = 64 - (bh >> 1);
  for (let y = y0; y < y0 + bh; y++) {
    for (let x = x0; x < x0 + bw; x++) {
      const i = (y * w + x) * 4;
      data[i] = 40; data[i + 1] = 40; data[i + 2] = 40; data[i + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

describe("the scale gate", () => {
  /**
   * The axis every other gate is blind to. Three real attack arms, same init
   * and seed, one prompt variable each:
   *
   *     arm            churn   boxes   AREA SWING   verdict by eye
   *     1 original     11.1%   20/21       7.3%     inert but stable
   *     2 freed pose   28.3%   21/21      43.9%     shrinks to a head
   *     3 + size pin   27.1%   21/21      62.3%     shrinks more
   *
   * `motion` scored arms 2 and 3 as a large IMPROVEMENT, because churn cannot
   * tell a lunge from a zoom-out — a receding figure changes a lot of pixels.
   */
  it("does not flag a clip that holds its size", () => {
    // The positive control: real motion, constant scale. This is the arm the
    // gate must stay quiet on, or it is just noise.
    const v = motionClip([frame(0), frame(6), frame(12), frame(18), frame(24)]);
    expect(v.scaleSwing, v.report).toBeLessThan(MOTION.SCALE_SWING_SOFT);
    expect(v.checks.find((c) => c.id === "scale")).toBeUndefined();
  });

  it("flags a ROCKING clip — big swing, flat trend — and names it as rocking", () => {
    /**
     * The false positive that rewrote this gate. N:run — a gallop — swung 33.1%
     * of its box area and came straight back: 1.16 1.14 1.04 0.86 0.82 0.78
     * 0.95 ... 1.12 1.17 1.16, trend +0.42%/frame. Flagging that would train
     * the operator to ignore the gate, which is worse than not having it.
     */
    const rocking = [1, 0.98, 0.9, 0.82, 0.78, 0.85, 0.95, 1.0, 1.02, 0.99].map(scaledFrame);
    const v = motionClip(rocking);
    expect(v.scaleSwing, v.report).toBeGreaterThan(MOTION.SCALE_SWING_SOFT);
    expect(v.scaleTrend, v.report).toBeGreaterThan(-MOTION.SCALE_TREND_SOFT); // comes back
    const c = v.checks.find((x) => x.id === "scale");
    expect(c, v.report).toBeDefined();
    expect(c!.value).toContain("rocking");
  });

  it("flags a figure that shrinks away", () => {
    const v = motionClip([scaledFrame(1), scaledFrame(0.85), scaledFrame(0.7), scaledFrame(0.55), scaledFrame(0.4)]);
    // 0.4 of each side is 0.16 of the area — an 84% swing.
    expect(v.scaleTrend, v.report).toBeLessThan(-MOTION.SCALE_TREND_SOFT);
    const check = v.checks.find((c) => c.id === "scale");
    expect(check, v.report).toBeDefined();
    expect(check!.soft).toBe(true);          // advisory: a death collapse really does shrink
    expect(v.level).not.toBe("reject");
  });

  it("tells ROCKING from RECEDING — same swing, opposite trend", () => {
    /**
     * The heart of it. Both clips swing hard; only one comes back. Measured on
     * real clips: N:run swung 33.1% at +0.42%/frame, attack arm 3 swung 62.3%
     * at -4.11%/frame. A gate keyed on swing calls both bad.
     */
    const gait = motionClip([1, 0.85, 0.72, 0.85, 1.0, 0.86, 0.73, 0.88, 1.0].map(scaledFrame));
    const recede = motionClip([1, 0.94, 0.87, 0.8, 0.72, 0.65, 0.58, 0.5, 0.43].map(scaledFrame));

    // Swing does NOT tell them apart — that is why the gate was rewritten.
    expect(Math.abs(gait.scaleSwing - recede.scaleSwing)).toBeLessThan(0.35);

    // Trend does, with a wide margin and opposite signs of the threshold.
    expect(gait.scaleTrend).toBeGreaterThan(-MOTION.SCALE_TREND_SOFT);
    expect(recede.scaleTrend).toBeLessThan(-MOTION.SCALE_TREND_SOFT);
    // BOTH are flagged — both are defects — but the message must differ, or
    // the operator cannot tell which fix applies.
    expect(gait.checks.find((c) => c.id === "scale")!.value).toContain("rocking");
    expect(recede.checks.find((c) => c.id === "scale")!.value).toContain("RECEDING");
  });
});
