/**
 * IS A ROW THE CLIP ITS LABEL CLAIMS, OR ANOTHER ROW WEARING THE NAME?
 *
 * `published.test.ts` asks whether the art REACHES the game. It does not ask
 * whether the frames under `attack` are an attack — and for a full year they
 * were not. The knight's roster generator fills the away-facing half of every
 * sheet with the SAME four standing back poses, and only three of the fourteen
 * source sheets animate it. `prep-knight.mjs`'s PLAN took `09_attack`'s bottom
 * row on the assumption that "bottom half = the same animation, seen from
 * behind", so the published N `attack` was the published N `idle`, frame for
 * frame — IoU 0.984-0.990, mean colour delta 6-11. Swinging while walking away
 * from the camera played a knight standing perfectly still.
 *
 * Nothing could catch it. The forge sliced 4 clean frames, the census scored
 * them, `importedPaints` packed them, the animator played them. Every stage did
 * its job on frames that were simply the wrong ones. The only signal available
 * is the one this file measures: a clip that IS another clip.
 *
 * ── WHY SILHOUETTE IoU, AND NOT A PIXEL DIFF ────────────────────────────────
 *
 * Cells are cropped to content, so two frames of the same pose land at
 * different sizes and a raw diff reports 100% on a one-pixel bbox change (which
 * is how the first pass at this measured "no duplicates" on the very sheet that
 * had them). Normalising both to a fixed box and comparing the OPAQUE MASK asks
 * the question that matters — is this the same pose? — and the colour delta
 * over the overlap separates "same pose, different gear" from "same frame".
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createCanvas, loadImage } from "canvas";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { installSpriteTestDom } from "../../testkit/atlas-census";
import type { SheetManifest } from "./manifest";

const PUBLIC = join(__dirname, "..", "..", "..", "..", "..", "public", "sprites");

/** The normalisation box. Tall, because every actor here is. */
const NW = 64;
const NH = 120;

/**
 * Clip pairs that are duplicates ON PURPOSE, with the reason.
 *
 * `run` reusing `walk` is the animator's own design: it ramps the playback rate
 * with the sprint charge rather than swapping art, and a sprint that cut to the
 * PROCEDURAL knight mid-charge would read as a different character. That is a
 * decision; an `attack` that is an `idle` is a defect. The difference between
 * them is written down here or it is not enforceable.
 */
const ALIASED: { sheet: string; a: string; b: string }[] = [
  { sheet: "pinball_knight", a: "walk", b: "run" },
  // fish_feet's source sheet ships two IDENTICAL bands and the sidecar labels
  // them idle+walk, so the creature walks on the spot when it stands still.
  // Deleting the row is not the fix: `importedPaints` returns null without an
  // `idle`, which drops BOTH facings and puts the whole creature back on its
  // painter (the exact way stiltneck shipped invisible for weeks). Until the
  // sheet is re-authored with a real idle band, reusing the walk is the choice.
  { sheet: "fish_feet", a: "idle", b: "walk" },
];

function isAliased(sheet: string, a: string, b: string): boolean {
  return ALIASED.some((x) => x.sheet === sheet && ((x.a === a && x.b === b) || (x.a === b && x.b === a)));
}

/** A cell, nearest-scaled into the normalisation box. */
function normalise(ctx: CanvasRenderingContext2D, cell: readonly number[]): ImageData {
  const [x0, y0, x1, y1] = cell;
  const c = createCanvas(NW, NH);
  const x = c.getContext("2d");
  x.imageSmoothingEnabled = false;
  x.drawImage(ctx.canvas as never, x0, y0, x1 - x0, y1 - y0, 0, 0, NW, NH);
  return x.getImageData(0, 0, NW, NH) as unknown as ImageData;
}

/** Silhouette IoU, plus the mean per-channel colour delta over the overlap. */
function compare(a: ImageData, b: ImageData): { iou: number; dcol: number } {
  let inter = 0;
  let union = 0;
  let dsum = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const av = a.data[i + 3] > 127;
    const bv = b.data[i + 3] > 127;
    if (av || bv) union++;
    if (av && bv) {
      inter++;
      dsum +=
        Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
    }
  }
  return { iou: union ? inter / union : 0, dcol: inter ? dsum / inter / 3 : 255 };
}

/**
 * The thresholds, set from MEASURED separation rather than picked.
 *
 * The defect (N attack vs N idle) scored IoU 0.984-0.990 at Δcolour 6-11. The
 * closest legitimate pair on the same sheet — S attack against S idle, the same
 * knight in the same armour on the same frame budget — scored IoU 0.657-0.697
 * at Δcolour 55-71. There is no sheet in the roster living between those, so
 * the gate sits well clear of both.
 */
const SAME_POSE_IOU = 0.95;
const SAME_ART_DCOL = 20;

let restore = (): void => {};
beforeAll(() => { restore = installSpriteTestDom(); });
afterAll(() => { restore(); });

describe("published sheets: a clip row is the clip it claims", () => {
  it("no clip row is a copy of another clip row", async () => {
    const sheets = readdirSync(PUBLIC).filter((f) => f.endsWith(".json"));
    expect(sheets.length, "public/sprites has no manifests — did the forge publish?").toBeGreaterThan(0);

    const complaints: string[] = [];
    for (const file of sheets) {
      const manifest = JSON.parse(readFileSync(join(PUBLIC, file), "utf8")) as SheetManifest;
      const png = join(PUBLIC, file.replace(/\.json$/, ".png"));
      if (!existsSync(png)) continue;
      const image = await loadImage(png);
      const canvas = createCanvas(image.width, image.height);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(image as never, 0, 0);

      const rows = manifest.rows.map((r) => ({
        clip: r.clip,
        frames: r.cells.map((c) => normalise(ctx as unknown as CanvasRenderingContext2D, c)),
      }));

      for (let i = 0; i < rows.length; i++) {
        for (let j = i + 1; j < rows.length; j++) {
          const A = rows[i];
          const B = rows[j];
          if (A.clip === B.clip) continue; // two physical rows of ONE long clip
          if (A.frames.length !== B.frames.length) continue; // not the same row
          if (isAliased(manifest.name, A.clip, B.clip)) continue;
          const scores = A.frames.map((f, k) => compare(f, B.frames[k]));
          const same = scores.every((s) => s.iou >= SAME_POSE_IOU && s.dcol <= SAME_ART_DCOL);
          if (!same) continue;
          const detail = scores
            .map((s, k) => `[${k}] IoU ${s.iou.toFixed(3)} Δcol ${s.dcol.toFixed(1)}`)
            .join(", ");
          complaints.push(
            `${manifest.name}-${manifest.dir}: "${A.clip}" and "${B.clip}" are the SAME FRAMES ` +
              `(${detail}). One of them is packed, played and completely invisible to the player — ` +
              `the source row the PLAN picked is not the animation its label claims. Either point ` +
              `that clip at art that actually moves, or declare the reuse in ALIASED with the reason.`,
          );
        }
      }
    }
    expect(complaints.join("\n"), complaints.join("\n")).toBe("");
  }, 120_000);
});
