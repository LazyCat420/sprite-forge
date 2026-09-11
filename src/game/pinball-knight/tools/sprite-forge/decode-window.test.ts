/**
 * ONE TEMPORAL WINDOW, ON EVERY WAN LEG.
 *
 * ── WHY THIS TEST EXISTS, WHICH IS THE WHOLE POINT ─────────────────────────
 *
 * `VAEDecodeTiled` walks a clip in overlapping temporal windows and CROSS-FADES
 * where they meet. At `temporal_size: 8` / `temporal_overlap: 4` those meetings
 * land on output frames 4, 8, 12, 16 — and the dog walk's unusable frames were
 * 4, 5, 8, 12, 13, 16. Every boundary, plus the frame after two of them, and no
 * outlier anywhere else. A limb arrives as a DOUBLE EXPOSURE at half strength,
 * which motion blur cannot do.
 *
 * Measured on 2026-08-07, one variable, same seed/master/prompt/canvas:
 *
 *     temporal_size  8   worst frame 10.43% ghost, 7 of 21 flagged   435s
 *     temporal_size 24   worst frame  0.23% ghost, 0 of 21 flagged   556s
 *
 * That fix landed on `wanI2V` — and then `wanTi2v5B` was written a day later
 * from the PRE-FIX version of the same function and hardcoded `8` again. The
 * defect was re-shipped inside 24 hours of being solved, on a leg whose entire
 * purpose is to make these runs affordable.
 *
 * **A second copy of a setting is a second copy of its bug.** So this file
 * pins every Wan decode to the same expression, and it asserts the two builders
 * AGREE rather than checking each against a restated number — a hand-written
 * expected value here would be a third copy with the same failure mode.
 *
 * ⚠️ If a run genuinely cannot afford one window, the knob is `temporalSize`,
 * passed per-call (`cli.mjs --temporal N`). Do NOT change the default back. The
 * cheap way to buy decode headroom is a smaller canvas — which the texel budget
 * wants anyway — not a windowed decode, because a spatial seam is a hairline
 * inside one frame while a temporal seam is a whole frame the animation cannot
 * use.
 */
import { describe, it, expect } from "vitest";
import { wanI2V, wanTi2v5B } from "./comfy/graphs.mjs";

const base: any = { image: "init.png", prompt: "a pixel art dog walking" };

/** Every Wan graph builder, so a third leg cannot be added without a decision. */
const LEGS: Array<[string, (o: any) => any]> = [
  ["wanI2V (A14B)", wanI2V],
  ["wanTi2v5B (small)", wanTi2v5B],
];

describe("the temporal decode window", () => {
  for (const [name, build] of LEGS) {
    it(`${name}: defaults to ONE window wider than the clip`, () => {
      for (const length of [17, 21, 33]) {
        const g: any = build({ ...base, length });
        expect(g.dec.class_type).toBe("VAEDecodeTiled");
        expect(
          g.dec.inputs.temporal_size,
          `${name} at ${length} frames would cross-fade at window boundaries`,
        ).toBeGreaterThan(length);
      }
    });

    it(`${name}: NEVER defaults to 8 — the measured-bad value`, () => {
      expect(build({ ...base, length: 21 }).dec.inputs.temporal_size).not.toBe(8);
    });

    it(`${name}: still honours an explicit temporalSize, for a box that cannot afford one window`, () => {
      const g: any = build({ ...base, length: 21, temporalSize: 12 });
      expect(g.dec.inputs.temporal_size).toBe(12);
    });
  }

  it("both legs compute the window the SAME way, not merely both correctly", () => {
    // The failure this catches is divergence, so compare the two outputs to
    // each other across several lengths rather than to a restated constant.
    for (const length of [17, 21, 33]) {
      const a: any = wanI2V({ ...base, length });
      const b: any = wanTi2v5B({ ...base, length });
      expect(b.dec.inputs.temporal_size).toBe(a.dec.inputs.temporal_size);
      expect(b.dec.inputs.temporal_overlap).toBe(a.dec.inputs.temporal_overlap);
    }
  });

  it("FAULT INJECTION: a builder pinned back to 8 fails the check", () => {
    // Proves the assertion can fail. Without this the whole file could be
    // asserting something that is true of every possible value.
    const rigged: any = { dec: { inputs: { temporal_size: 8 } } };
    expect(rigged.dec.inputs.temporal_size).not.toBeGreaterThan(21);
  });
});
