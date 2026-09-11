/**
 * THE COMPASS SHEETS STILL POINT WHERE THEIR NAME SAYS.
 *
 * `prep/make-compass.mjs` writes three calibration sheets whose figures carry
 * a direction arrow, a chiral letter and a left-red/right-white flip marker.
 * This test loads the PUBLISHED result through the real import path and
 * asserts the geometry — so a mislabelled manifest, an accidental global
 * mirror, or a packing step that flips cells fails HERE with the direction
 * named, rather than as "the knight moonwalks" three layers up.
 *
 * It READS public/sprites; it never regenerates the fixtures (a test file
 * must not publish tracked art). Regenerate with the prep script + publish.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { loadImage, createCanvas } from "canvas";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installSpriteTestDom, bufferFor, SHIPPED_GRID } from "../../testkit/atlas-census";
import { importedPaints, type ImportedSheet } from "../../render/imported-paints";
import { paintInArtSpace } from "../../engine/render/sprite";
import type { SheetManifest } from "./manifest";

const PUBLIC = join(__dirname, "..", "..", "..", "..", "..", "public", "sprites");

/** Mirrors prep/make-compass.mjs — the fixture's own ink contract. */
const ARROW: Record<string, [number, number, number]> = {
  S: [0x3c, 0xb4, 0x4b],
  N: [0x43, 0x63, 0xd8],
  E: [0xf5, 0x82, 0x31],
};
const LEFT_MARK: [number, number, number] = [0xe6, 0x19, 0x4b];
const RIGHT_MARK: [number, number, number] = [0xff, 0xff, 0xff];

let restore = (): void => {};
beforeAll(() => { restore = installSpriteTestDom(); });
afterAll(() => { restore(); });

async function load(dir: "S" | "N" | "E"): Promise<ImportedSheet> {
  const manifest = JSON.parse(readFileSync(join(PUBLIC, `compass-${dir}.json`), "utf8")) as SheetManifest;
  const image = await loadImage(join(PUBLIC, `compass-${dir}.png`));
  return { manifest, image: image as unknown as CanvasImageSource };
}

/** Paint idle[0] through the real import path; centroid of ink near a colour. */
function centroid(sheet: ImportedSheet, ink: [number, number, number]): { x: number; y: number; n: number } {
  const px = bufferFor(SHIPPED_GRID);
  const buf = createCanvas(px, px);
  const ctx = buf.getContext("2d") as unknown as CanvasRenderingContext2D;
  const paints = importedPaints([sheet]);
  expect(paints, `compass-${sheet.manifest.dir}: no playable paints`).not.toBeNull();
  paintInArtSpace(ctx, paints!.S.idle![0], px);
  const d = (ctx as unknown as { getImageData(a: number, b: number, c: number, e: number): ImageData })
    .getImageData(0, 0, px, px).data;
  let sx = 0, sy = 0, n = 0;
  for (let y = 0; y < px; y++) {
    for (let x = 0; x < px; x++) {
      const at = (y * px + x) * 4;
      if (d[at + 3] < 128) continue;
      const dist = (d[at] - ink[0]) ** 2 + (d[at + 1] - ink[1]) ** 2 + (d[at + 2] - ink[2]) ** 2;
      // Loose gate: the k-centroid resample shifts edge colours, the body of a
      // 24px block does not move far.
      if (dist < 3600) { sx += x; sy += y; n++; }
    }
  }
  return { x: n ? sx / n / px : 0.5, y: n ? sy / n / px : 0.5, n };
}

describe("compass calibration sheets", () => {
  it("each facing's arrow ink points where the manifest's dir says", async () => {
    // Compared against the BODY's own centroid, not the buffer midline —
    // `cellPlacement` anchors feet to the ground line, so absolute positions
    // shift with figure height but "the arrow extends out of the body toward
    // the facing" is true in any anchoring.
    const BODY: [number, number, number] = [0x66, 0x6a, 0x72];
    for (const dir of ["S", "N", "E"] as const) {
      const sheet = await load(dir);
      const arrow = centroid(sheet, ARROW[dir]);
      const body = centroid(sheet, BODY);
      expect(arrow.n, `compass-${dir}: arrow ink missing after import`).toBeGreaterThan(30);
      expect(body.n, `compass-${dir}: body ink missing after import`).toBeGreaterThan(30);
      if (dir === "S") expect(arrow.y, "S arrow extends screen-down of the body").toBeGreaterThan(body.y);
      if (dir === "N") expect(arrow.y, "N arrow extends screen-up of the body").toBeLessThan(body.y);
      if (dir === "E") expect(arrow.x, "E arrow extends screen-right of the body").toBeGreaterThan(body.x);
    }
  });

  it("left-red / right-white marks agree, and mirror:true swaps them", async () => {
    const plain = await load("E");
    const red = centroid(plain, LEFT_MARK);
    const white = centroid(plain, RIGHT_MARK);
    expect(red.n).toBeGreaterThan(10);
    expect(white.n).toBeGreaterThan(10);
    expect(red.x, "red is the figure's LEFT edge").toBeLessThan(white.x);

    // The same sheet with the manifest's mirror declared must swap the marks —
    // the runtime half of the sidecar `mirror` contract, proven on the fixture
    // whose whole purpose is to make a flip visible.
    const mirrored = await load("E");
    mirrored.manifest.mirror = true;
    const mRed = centroid(mirrored, LEFT_MARK);
    const mWhite = centroid(mirrored, RIGHT_MARK);
    expect(mRed.x, "mirror:true must flip the marks").toBeGreaterThan(mWhite.x);
  });
});
