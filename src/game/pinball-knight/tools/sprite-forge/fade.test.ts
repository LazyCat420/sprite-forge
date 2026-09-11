/**
 * The fade gate, against the clip that motivated it.
 *
 * The real fixture here is COMMITTED (`sources/dog-2026-08-07`, the approved
 * walk), so unlike ghost's positive fixture this never skips. That matters more
 * than usual: the defect was found by eye on art this pipeline had already
 * approved, so the fixture IS the bug report.
 *
 * ── WHAT THE SYNTHETIC HALF HAS TO PROVE ────────────────────────────────────
 *
 * That the gate is measuring feature LOSS and not just "the picture changed".
 * A clip whose subject moves normally must pass; a clip where one marking is
 * absorbed into the body must fail — and critically, the second must fail while
 * its overall brightness stays put, because a whole-frame brightness check
 * would catch that case for the wrong reason and then miss the real one.
 */
import { describe, it, expect } from "vitest";
import { loadImage, createCanvas } from "canvas";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fadeClip, FADE } from "./fade";
import type { RawImage } from "./resample";

const APPROVED_WALK = join(__dirname, "sources", "dog-2026-08-07");

async function png(path: string): Promise<RawImage> {
  const img = await loadImage(path);
  const c = createCanvas(img.width, img.height);
  c.getContext("2d").drawImage(img, 0, 0);
  const d = c.getContext("2d").getImageData(0, 0, img.width, img.height);
  return { width: img.width, height: img.height, data: d.data as unknown as Uint8ClampedArray };
}

/**
 * A dark body with `markingPx` pixels of a bright marking on it, on a white
 * field. Shrinking the marking is a feature being absorbed by the body — the
 * exact defect — and it deliberately barely moves the frame's mean luminance.
 */
function frame(markingPx: number, shift = 0): RawImage {
  const w = 96, h = 96;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = 255; data[i * 4 + 1] = 255; data[i * 4 + 2] = 255; data[i * 4 + 3] = 255;
  }
  const put = (x: number, y: number, c: [number, number, number]) => {
    if (x < 0 || x >= w || y < 0 || y >= h) return;
    const i = (y * w + x) * 4;
    data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
  };
  // Body: a big dark block.
  for (let y = 20; y < 80; y++) for (let x = 20 + shift; x < 76 + shift; x++) put(x, y, [20, 18, 30]);
  // Marking: a bright patch whose AREA is the variable.
  let placed = 0;
  for (let y = 66; y < 78 && placed < markingPx; y++) {
    for (let x = 24 + shift; x < 72 + shift && placed < markingPx; x++, placed++) put(x, y, [190, 180, 160]);
  }
  return { width: w, height: h, data };
}

describe("the fade gate", () => {
  it("passes a clip that moves but keeps its colours", () => {
    const v = fadeClip([0, 2, 4, 6, 4, 2].map((s) => frame(400, s)));
    expect(v.level, v.report).toBe("ready");
  });

  it("fails a clip where a marking is absorbed into the body", () => {
    // 400 px of marking on most frames, 80 on one — an 80% loss.
    const v = fadeClip([400, 400, 400, 80, 400, 400].map((n) => frame(n)));
    expect(v.level, v.report).toBe("reject");
    expect(v.flagged).toContain(3);
    expect(v.report).toMatch(/lost one of the creature's colours/);
  });

  it("catches it even though the frame's overall brightness barely moves", () => {
    // The reason this is not a luminance check. The marking is ~7% of the
    // figure, so losing it moves mean luminance by a couple of points — under
    // any sane global-brightness threshold, while being plainly visible.
    const full = frame(400), lost = frame(80);
    const mean = (im: RawImage) => {
      let s = 0, n = 0;
      for (let i = 0; i < im.data.length; i += 4) {
        if (im.data[i] > 245 && im.data[i + 1] > 245) continue;       // skip field
        s += (im.data[i] + im.data[i + 1] + im.data[i + 2]) / 3; n++;
      }
      return s / n;
    };
    expect(Math.abs(mean(full) - mean(lost))).toBeLessThan(20);
    expect(fadeClip([full, full, lost, full]).level).toBe("reject");
  });

  it("ignores clusters too small to be a feature", () => {
    // A handful of pixels swings its own share wildly for free. If those
    // counted, every clip would fail and the gate would be noise.
    const v = fadeClip([frame(400), frame(400), frame(398), frame(400)]);
    expect(v.level, v.report).toBe("ready");
    expect(FADE.MIN_SHARE).toBeGreaterThan(0);
  });
});

describe("the approved dog walk", () => {
  it("reproduces the tan-paw dip the operator saw, and only as advisory", async () => {
    const names = readdirSync(APPROVED_WALK).filter((f) => f.endsWith(".png")).sort();
    const cells = await Promise.all(names.map((n) => png(join(APPROVED_WALK, n))));
    const v = fadeClip(cells, { label: "dog walk" });

    // Independently measured at 22.5% on frame 5 with a separate probe before
    // this file existed. Asserting the BAND, not the number — a hair of
    // clustering nondeterminism must not turn a real finding into a red suite.
    expect(v.level, v.report).toBe("usable");
    expect(v.report).toMatch(/a marking dims/);
    expect(v.report).toMatch(/frame 5\b/);

    // And it must NOT reject: this is shipped, approved art. A gate that
    // condemns the only clip we have approved is the failure this repo has
    // already hit twice.
    expect(v.flagged).toEqual([]);

    /**
     * The magnitude has to survive into the RESULT, not just the report text.
     *
     * `flagged` is empty for every soft finding by design, and `level` is
     * three-valued — so without `worst` the only record of "22.5% on frame 5"
     * is a prose line, and a sweep of twenty clips could not be ranked without
     * re-running the gate on all of them. Every gait clip in the first sweep
     * came back `usable`; that word is identical for a 21% dip and a 39% one.
     */
    expect(v.worst).not.toBeNull();
    expect(v.worst!.frame).toBe(5);
    expect(v.worst!.drop).toBeGreaterThan(FADE.SOFT_DROP);
    expect(v.worst!.drop).toBeLessThan(FADE.DROP);
    // The tan markings, not one of the three body clusters.
    expect(v.worst!.colour).toMatch(/^#[0-9a-f]{6}$/);
    expect(v.report).toContain(v.worst!.colour);
  });
});
