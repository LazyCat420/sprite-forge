/**
 * The curator has to drop the receding tail, not sample across it.
 *
 * The 2026-08-08 sweep produced clips whose figure shrank monotonically across
 * 21 frames — N:death at 72% total area swing. Only 3-4 frames ship, so the
 * question is never "is the clip stable", it is "are the frames we KEEP
 * stable". Measured on that clip: 72% raw, 23% curated.
 *
 * `take every Nth` would sample straight across the recession and inherit it,
 * which is why this is a filter and not a stride.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "module";
import { pickFrames, DEFAULT_K } from "./prep/pick-frames.mjs";

const require = createRequire(import.meta.url);
const { createCanvas } = require("canvas");

/** A dark blob of a given scale on a white field, written as a real PNG. */
function writeFrame(dir: string, i: number, scale: number) {
  const w = 128, h = 128;
  const c = createCanvas(w, h);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  const bw = Math.round(40 * scale), bh = Math.round(50 * scale);
  ctx.fillStyle = "#282828";
  ctx.fillRect(64 - (bw >> 1), 100 - bh, bw, bh);
  // A moving mark so consecutive frames are not pose-identical.
  ctx.fillStyle = "#c8b090";
  ctx.fillRect(56 + ((i * 7) % 18), 100 - Math.round(bh * 0.15), 6, 5);
  writeFileSync(join(dir, `wan_0${String(1000 + i)}_.png`), c.toBuffer("image/png"));
}

describe("pickFrames", () => {
  it("drops a receding tail instead of sampling across it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "recede-"));
    // Stable for 12 frames, then shrinks away — the N:death shape.
    for (let i = 0; i < 21; i++) writeFrame(dir, i, i < 12 ? 1 : 1 - (i - 11) * 0.07);

    const { picked } = await pickFrames(dir, { k: 4 });
    const idx = picked.map((p) => Number(p) - 1000);

    // Every kept frame must come from the stable region. A stride-based
    // sampler would have taken frames 0, 7, 14, 20 and inherited the shrink.
    expect(idx.every((i) => i < 14), `picked ${idx}`).toBe(true);
    expect(picked).toHaveLength(4);
  });

  it("picks poses that DIFFER, which is not the same as evenly spaced indices", async () => {
    /**
     * The first version of this test asserted index spacing. That is the wrong
     * quantity: the picker optimises POSE distance, and in this fixture the
     * mark's position is periodic, so the most different poses are not the
     * most widely spaced frames. Asserting spacing tested the fixture's
     * arithmetic rather than the picker's job.
     */
    const dir = mkdtempSync(join(tmpdir(), "poses-"));
    for (let i = 0; i < 21; i++) writeFrame(dir, i, 1);
    const { picked } = await pickFrames(dir, { k: 4 });
    expect(picked).toHaveLength(4);
    // No frame chosen twice, and every pair is a genuinely different picture.
    expect(new Set(picked).size).toBe(4);
    const idx = picked.map((p) => Number(p) - 1000);
    const marks = idx.map((i) => (i * 7) % 18);
    expect(new Set(marks).size, `picked ${idx} -> marks ${marks}`).toBe(4);
  });

  it("honours the gates' named frames", async () => {
    const dir = mkdtempSync(join(tmpdir(), "avoid-"));
    for (let i = 0; i < 21; i++) writeFrame(dir, i, 1);
    const avoid = [0, 1, 2, 3, 4, 5, 6, 7];
    const { picked } = await pickFrames(dir, { k: 4, avoid });
    const idx = picked.map((p) => Number(p) - 1000);
    expect(idx.some((i) => avoid.includes(i)), `picked ${idx}`).toBe(false);
  });

  it("keeps crouch at 3 frames — it is timed against LEAP_WINDUP", () => {
    // anim.crouch is 7fps and LEAP_WINDUP is 0.45s, so 3 frames = 0.43s. A
    // longer telegraph finishes after the pounce has already started.
    expect(DEFAULT_K.crouch).toBe(3);
    expect(DEFAULT_K.crouch / 7).toBeLessThan(0.45);
  });
});
