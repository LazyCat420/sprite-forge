/**
 * INTAKE — the geometry and the gate, on synthetic frames.
 *
 * No network, no canvas, no GPU: intake is pure by design so the half of the
 * road that decides whether generation is worth starting can be proven without
 * starting it.
 *
 * The cases are the failures this stage exists to catch, each one taken from a
 * real incident: a photo-shaped background the matte cannot key, two subjects
 * in one frame (the "row of four frogs"), a ground shadow under the feet
 * (which lifts the character in every frame), and a figure so small the style
 * pass would be inventing rather than recovering.
 */
import { describe, expect, it } from "vitest";
import { blobs, subjectOf } from "./blobs";
import { FEET, INTAKE_PX, SUBJECT_H, fill, flattenOnKey, letterbox, reframeSubject } from "./intake";
import { qaFrame } from "./intake-qa";
import type { RawImage } from "./resample";

/** A solid rectangle with alpha, on a transparent field. */
function figure(w: number, h: number, box: [number, number, number, number], rgb = [40, 160, 60]): RawImage {
  const img = fill(w, h, [255, 255, 255], 0);
  const [x0, y0, x1, y1] = box;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * w + x) * 4;
      img.data[i] = rgb[0];
      img.data[i + 1] = rgb[1];
      img.data[i + 2] = rgb[2];
      img.data[i + 3] = 255;
    }
  }
  return img;
}

/**
 * A creature-SHAPED silhouette: head, body, two legs with a gap between them.
 *
 * A filled rectangle is not a usable fixture here, and finding that out was
 * worth the detour: `sliceSheet` erases any row whose ink is one long
 * contiguous run, because that is precisely what a RULED LINE looks like
 * (`slice.ts` — measured on the frog sheet). A solid block is every row a rule,
 * so it slices to nothing. Real art never is one, and neither is this.
 */
function creature(w: number, h: number, box: [number, number, number, number]): RawImage {
  const img = fill(w, h, [255, 255, 255], 0);
  const [x0, y0, x1, y1] = box;
  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  const ink = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 4;
    img.data[i] = 40;
    img.data[i + 1] = 160;
    img.data[i + 2] = 60;
    img.data[i + 3] = 255;
  };
  const headH = Math.round(bh * 0.28);
  const bodyH = Math.round(bh * 0.42);
  const legTop = y0 + headH + bodyH;
  // head: a narrower dome
  for (let y = y0; y < y0 + headH; y++)
    for (let x = x0 + Math.round(bw * 0.22); x <= x1 - Math.round(bw * 0.22); x++) ink(x, y);
  // torso: full width
  for (let y = y0 + headH; y < legTop; y++) for (let x = x0; x <= x1; x++) ink(x, y);
  // two legs with a gap — this is what stops the bottom reading as a shelf
  const legW = Math.max(1, Math.round(bw * 0.28));
  for (let y = legTop; y <= y1; y++) {
    for (let x = x0; x < x0 + legW; x++) ink(x, y);
    for (let x = x1 - legW + 1; x <= x1; x++) ink(x, y);
  }
  return img;
}

describe("blobs", () => {
  it("counts separate figures and ranks them by area", () => {
    const img = figure(200, 200, [10, 10, 40, 100]);
    // a second, smaller figure with a clear gap
    for (let y = 20; y <= 60; y++)
      for (let x = 120; x <= 140; x++) {
        const i = (y * 200 + x) * 4;
        img.data[i + 3] = 255;
      }
    const found = blobs(img.data, 200, 200);
    expect(found).toHaveLength(2);
    expect(found[0].area).toBeGreaterThan(found[1].area);
    const { subject, extras } = subjectOf(found);
    expect(subject!.area).toBe(found[0].area);
    expect(extras).toHaveLength(1);
  });

  it("does not weld two figures that only touch diagonally", () => {
    const img = fill(20, 20, [255, 255, 255], 0);
    const put = (x: number, y: number) => (img.data[(y * 20 + x) * 4 + 3] = 255);
    put(5, 5);
    put(6, 6); // diagonal neighbour only
    expect(blobs(img.data, 20, 20)).toHaveLength(2);
  });

  it("drops specks under 1% of the subject but reports them", () => {
    const img = figure(200, 200, [10, 10, 100, 180]);
    img.data[(5 * 200 + 190) * 4 + 3] = 255; // one stray pixel
    const { extras, specks } = subjectOf(blobs(img.data, 200, 200));
    expect(extras).toHaveLength(0);
    expect(specks).toHaveLength(1);
  });
});

describe("letterbox", () => {
  it("fits a wide image into a square without distorting it", () => {
    const src = figure(400, 100, [0, 0, 399, 99]);
    const { image, scale } = letterbox(src, 256);
    expect(image.width).toBe(256);
    expect(image.height).toBe(256);
    // 400 -> 256 is the binding axis
    expect(scale).toBeCloseTo(256 / 400, 5);
  });
});

describe("reframeSubject", () => {
  it("puts the subject at the contract height with its feet on the line", () => {
    // a small figure adrift in the top-left corner
    const src = figure(INTAKE_PX, INTAKE_PX, [40, 30, 140, 260]);
    const framed = reframeSubject(src);
    const [, y0, , y1] = framed.bbox;
    const h = (y1 - y0 + 1) / INTAKE_PX;
    expect(h).toBeCloseTo(SUBJECT_H, 1);
    expect(framed.feetY).toBeCloseTo(Math.round(FEET * INTAKE_PX), -1);
    expect(framed.centreX).toBeCloseTo(INTAKE_PX / 2, -1);
  });

  it("reports the source height so an upscale can be judged honestly", () => {
    const src = figure(INTAKE_PX, INTAKE_PX, [10, 10, 40, 100]);
    const framed = reframeSubject(src);
    expect(framed.sourceH).toBe(91);
    expect(framed.scale).toBeGreaterThan(4); // a 91px subject blown to 0.72 of 1024
  });

  it("strips a ground shelf when asked, so the feet are the lowest ink", () => {
    const src = creature(400, 400, [150, 100, 250, 300]);
    // a wide flat shadow band under the figure
    for (let y = 301; y <= 310; y++)
      for (let x = 120; x <= 280; x++) src.data[(y * 400 + x) * 4 + 3] = 255;
    const withShelf = reframeSubject(src, { size: 400 });
    const stripped = reframeSubject(src, { size: 400, stripShelf: true });
    expect(stripped.notes.join(" ")).toContain("shelf");
    // Measured on the SOURCE box, not the output: every frame is scaled to the
    // same contract height, so a shorter subject comes back magnified rather
    // than smaller. What the strip actually did is exclude the shadow rows.
    expect(stripped.sourceH).toBeLessThan(withShelf.sourceH);
  });

  it("throws rather than guessing when segmentation removed everything", () => {
    expect(() => reframeSubject(fill(64, 64, [255, 255, 255], 0))).toThrow(/nothing opaque/i);
  });

  /**
   * THE WHITE-RECTANGLE BUG, as the pipeline actually produced it.
   *
   * A Qwen or Wan frame is fully opaque — the generator has no alpha to write
   * — so the subject blob was the WHOLE canvas and the reframe scaled that
   * entire white field to subject height. The published "sprite" was a solid
   * block with the creature buried in it.
   *
   * The fixture is exactly that: a creature composited onto opaque white, the
   * byte-for-byte shape a generation arrives in. The assertion is on the
   * SILHOUETTE, not merely on "it did something": a pass here has to mean the
   * output is figure-shaped, because the old code also returned a frame.
   */
  it("keys an opaque generation before measuring it — the white-rectangle bug", () => {
    const src = flattenOnKey(creature(INTAKE_PX, INTAKE_PX, [300, 200, 720, 880]));
    // Exactly what comes off the GPU: no transparent pixel anywhere.
    for (let i = 3; i < src.data.length; i += 4) src.data[i] = 255;

    const framed = reframeSubject(src);
    const v = qaFrame(flattenOnKey(framed.image));
    const sil = v.checks.find((c) => c.id === "silhouette")!;
    expect(sil.pass).toBe(true);
    // The old behaviour, stated as a number so a regression cannot be quiet:
    // the block filled 100% of its own box and this figure is nowhere near it.
    expect(Number.parseFloat(sil.value)).toBeLessThan(80);
    expect(framed.notes.join(" ")).toMatch(/keyed an opaque frame/i);
  });
});

describe("flattenOnKey", () => {
  it("makes transparent pixels the key colour but keeps the alpha mask", () => {
    const src = figure(32, 32, [8, 8, 24, 24]);
    const out = flattenOnKey(src);
    const corner = (0 * 32 + 0) * 4;
    expect([out.data[corner], out.data[corner + 1], out.data[corner + 2]]).toEqual([255, 255, 255]);
    expect(out.data[corner + 3]).toBe(0); // alpha survives for the slicer
    const inside = (16 * 32 + 16) * 4;
    expect(out.data[inside + 3]).toBe(255);
  });
});

describe("qaFrame", () => {
  it("passes a frame built to the contract", () => {
    const src = creature(INTAKE_PX, INTAKE_PX, [40, 30, 140, 260]);
    const v = qaFrame(flattenOnKey(reframeSubject(src).image));
    expect(v.level).not.toBe("reject");
    expect(v.checks.find((c) => c.id === "size")!.pass).toBe(true);
    expect(v.checks.find((c) => c.id === "feet")!.pass).toBe(true);
  });

  it("flags two figures — the row-of-copies failure", () => {
    // Two properly-sized creatures side by side: the SIZE check passes, so the
    // only thing wrong is that there are two of them.
    const src = creature(INTAKE_PX, INTAKE_PX, [120, 150, 400, 890]);
    const second = creature(INTAKE_PX, INTAKE_PX, [600, 150, 880, 890]);
    for (let i = 0; i < src.data.length; i += 4)
      if (second.data[i + 3]) {
        src.data[i] = second.data[i];
        src.data[i + 1] = second.data[i + 1];
        src.data[i + 2] = second.data[i + 2];
        src.data[i + 3] = 255;
      }
    const v = qaFrame(flattenOnKey(src));
    const one = v.checks.find((c) => c.id === "one-figure")!;
    expect(one.pass).toBe(false);
    expect(one.why).toMatch(/bounding box/);
  });

  /**
   * THE NEGATIVE CONTROL for `silhouette`, and the reason it had to be added.
   *
   * Both frames here are keyed, correctly sized, correctly centred, and land
   * their feet on the line — so `alpha`, `size`, `feet`, `centre` and `matte`
   * report identically on the two of them. The ONLY difference is that one is
   * a creature and the other is a filled rectangle, which is exactly the pair
   * the old check set could not tell apart: the white-block reframe passed
   * every one of them. A check that agrees on both states is not a check.
   */
  it("tells a figure from a filled block — the state the other checks share", () => {
    const shaped = qaFrame(flattenOnKey(reframeSubject(creature(INTAKE_PX, INTAKE_PX, [300, 200, 720, 880])).image));
    const block = qaFrame(flattenOnKey(reframeSubject(figure(INTAKE_PX, INTAKE_PX, [300, 200, 720, 880])).image));

    expect(shaped.checks.find((c) => c.id === "silhouette")!.pass).toBe(true);
    expect(block.checks.find((c) => c.id === "silhouette")!.pass).toBe(false);

    // …and the checks that CANNOT see it agree on both, which is the point.
    for (const id of ["alpha", "size", "feet", "centre"]) {
      const a = shaped.checks.find((c) => c.id === id);
      const b = block.checks.find((c) => c.id === id);
      expect(a?.pass, `${id} should not be what separates them`).toBe(b?.pass);
    }
  });

  it("REJECTS an opaque frame — segmentation never ran", () => {
    const v = qaFrame(fill(256, 256, [30, 30, 30]));
    expect(v.checks.find((c) => c.id === "alpha")!.pass).toBe(false);
    expect(v.level).toBe("reject");
  });

  it("flags a figure that is clipped at the canvas edge", () => {
    const src = creature(512, 512, [0, 100, 300, 460]);
    const v = qaFrame(flattenOnKey(src));
    expect(v.checks.find((c) => c.id === "clip")!.pass).toBe(false);
    expect(v.level).toBe("reject");
  });

  it("warns about an upscale that invents rather than recovers", () => {
    const src = creature(INTAKE_PX, INTAKE_PX, [10, 10, 40, 100]);
    const framed = reframeSubject(src);
    const v = qaFrame(flattenOnKey(framed.image), { sourceH: framed.sourceH });
    const up = v.checks.find((c) => c.id === "upscale")!;
    expect(up.pass).toBe(false);
    expect(up.value).toMatch(/×/);
  });

  it("writes a report a human can act on", () => {
    const v = qaFrame(fill(128, 128, [200, 30, 30]));
    expect(v.report).toContain("VERDICT REJECT");
    expect(v.report).toMatch(/background is transparent/);
  });

  /**
   * THE NEGATIVE CONTROL FOR `grid`, which for its whole life could not fail.
   *
   * It was written `pass: true`, hardcoded, labelled "information, never a
   * gate" — so a frame drawn on a real lattice and a smooth painting produced
   * the same PASS and the same verdict level. That is the shape of a check that
   * checks nothing, and it had a job: `grid` is the ONLY thing in this file that
   * can tell art drawn as pixel art from art that will merely be crushed into
   * it. Everything else here measures the crush's output, and the crush makes
   * any input look gridded — `commit.ts` scored the moveset rejected on sight
   * on 2026-08-07 and the one that was kept identically at ×8 / 100% / 100%.
   *
   * The two frames below differ in exactly one property: one is drawn in 8×8
   * blocks, the other is the same figure with a smooth gradient over it. Every
   * other check must agree on them, or this control is not isolating `grid`.
   */
  it("tells art drawn on a lattice from a smooth painting", () => {
    const box: [number, number, number, number] = [300, 200, 720, 880];
    const blocky = creature(INTAKE_PX, INTAKE_PX, box);
    // Quantise to an 8px lattice — every 8×8 block takes its top-left texel,
    // which is what art authored at 1:8 actually looks like.
    for (let y = 0; y < INTAKE_PX; y++) {
      for (let x = 0; x < INTAKE_PX; x++) {
        const src = ((y - (y % 8)) * INTAKE_PX + (x - (x % 8))) * 4;
        const dst = (y * INTAKE_PX + x) * 4;
        for (let c = 0; c < 4; c++) blocky.data[dst + c] = blocky.data[src + c];
      }
    }
    // The same figure, continuous: a per-pixel ramp, the anti-aliased shape a
    // diffusion model returns.
    const smooth = creature(INTAKE_PX, INTAKE_PX, box);
    for (let y = 0; y < INTAKE_PX; y++) {
      for (let x = 0; x < INTAKE_PX; x++) {
        const i = (y * INTAKE_PX + x) * 4;
        if (!smooth.data[i + 3]) continue;
        smooth.data[i] = (smooth.data[i] + x) % 256;
        smooth.data[i + 1] = (smooth.data[i + 1] + y) % 256;
      }
    }

    const a = qaFrame(flattenOnKey(blocky), { afterStyle: true });
    const b = qaFrame(flattenOnKey(smooth), { afterStyle: true });

    expect(a.checks.find((c) => c.id === "grid")!.pass).toBe(true);
    expect(b.checks.find((c) => c.id === "grid")!.pass).toBe(false);
    // Named, so the report tells whoever reads it what to do about it rather
    // than only that a line went red.
    expect(b.checks.find((c) => c.id === "grid")!.fix).toMatch(/not pixel art/i);
  });

  it("does not reject a continuous sheet — the roster is made of them", () => {
    // SOFT on purpose. jester, rotortail, croaker and fish_feet all came in as
    // continuous art and all ship; a hard gate would reject the existing roster
    // to make a point. "usable" is the honest level: it can ship, and it is not
    // what it claims to be.
    const smooth = creature(INTAKE_PX, INTAKE_PX, [300, 200, 720, 880]);
    for (let y = 0; y < INTAKE_PX; y++) {
      for (let x = 0; x < INTAKE_PX; x++) {
        const i = (y * INTAKE_PX + x) * 4;
        if (smooth.data[i + 3]) smooth.data[i] = (smooth.data[i] + x) % 256;
      }
    }
    const v = qaFrame(flattenOnKey(reframeSubject(smooth).image), { afterStyle: true });
    expect(v.level).not.toBe("reject");
  });
});
