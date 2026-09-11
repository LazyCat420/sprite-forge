/**
 * IMPORTED vs PAINTED — the comparison this whole pipeline was built to make.
 *
 * Both painters were authored FROM these exact sheets as shape specs (see the
 * headers of render/monsters/jester.ts and rotortail.ts), so this is the same
 * creature drawn two ways, through one crush, at one rung. That makes it an
 * absolute oracle rather than a vibe check: whatever the difference is, it is
 * not "different art".
 *
 * It asserts only that imported frames are VALID — non-empty and palette-true.
 * It does not assert that imported wins, because on current evidence it does
 * not, and a test that demanded it would either be deleted or would quietly
 * pin a target nobody is trying to hit. The numbers are printed and written to
 * `work/ab.txt`; the side-by-side lands in `work/ab-<name>.png`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createCanvas, loadImage } from "canvas";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installSpriteTestDom, SHIPPED_GRID, bufferFor } from "../../testkit/atlas-census";
import { censusCell, paletteRgb, type CellStats } from "../../render/atlas-census";
import { crushToGrid, paintInArtSpace } from "../../engine/render/sprite";
import { withRecoil, makeZombiePaints, makeBrutePaints, ZOMBIE_VARIANTS, type ActorPaints } from "../../render/cel-painter";
import { makeJesterPaints } from "../../render/monsters/jester";
import { makeRotortailPaints } from "../../render/monsters/rotortail";
import { makeStiltneckPaints } from "../../render/monsters/stiltneck";
import { makeKnightPaints } from "../../render/cel-painter";
import { FULL_PLATE } from "../../render/knight-look";
import { importedPaints, type ImportedSheet } from "../../render/imported-paints";
import type { SheetManifest } from "./manifest";
import type { ClipName, Dir, FramePaint } from "../../engine/render/paint-types";

const PUBLIC = join(__dirname, "..", "..", "..", "..", "..", "public", "sprites");
const WORK = join(__dirname, "work");

/**
 * Every creature with BOTH a published sheet and a painter — which is a
 * superset of `IMPORTED_ART` in boot/sheets.ts, on purpose. `stiltneck` is here
 * and not there: this is the measurement that says the painter wins, so
 * dropping the pair when the import is switched off would delete the evidence
 * for the decision.
 *
 * `dir` is the facing the sheet AUTHORS, and both sides are read from it: an
 * E-only creature scored on S would compare its borrowed profile against a
 * painter's real front view, which is a facing difference reported as a
 * fidelity one.
 */
const PAIRS: { key: string; sheet: string; dir: Dir; painted: () => ActorPaints }[] = [
  // The first creature the LOCAL pipeline built end to end, so this pair is
  // the one measurement that is not scoring a bought sheet against a painter.
  { key: "brute", sheet: "brute", dir: "S", painted: makeBrutePaints },
  { key: "jester", sheet: "jester", dir: "S", painted: makeJesterPaints },
  { key: "rotortail", sheet: "beaver", dir: "S", painted: makeRotortailPaints },
  { key: "zombie", sheet: "zombie", dir: "E", painted: () => makeZombiePaints(ZOMBIE_VARIANTS[0]) },
  { key: "stiltneck", sheet: "stiltneck", dir: "E", painted: makeStiltneckPaints },
  // The player himself — imported red-plume roster vs the procedural knight.
  // Sword is the starting weapon, so it is the painter most runs actually see.
  { key: "pinball_knight", sheet: "pinball_knight", dir: "S", painted: () => makeKnightPaints("sword", FULL_PLATE) },
];

let restore = (): void => {};
beforeAll(() => { restore = installSpriteTestDom(); });
afterAll(() => { restore(); });

const G = SHIPPED_GRID;
const PX = bufferFor(G);

/** One FramePaint through the production path, as ImageData at the shipped rung. */
function crush(paint: FramePaint): ImageData {
  const buf = createCanvas(PX, PX);
  const ctx = buf.getContext("2d") as unknown as CanvasRenderingContext2D;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, PX, PX);
  paintInArtSpace(ctx, paint, PX);
  const cell = crushToGrid(buf as unknown as HTMLCanvasElement, G);
  return (cell.getContext("2d") as unknown as CanvasRenderingContext2D).getImageData(0, 0, G, G);
}

function mean(rows: CellStats[], f: (s: CellStats) => number): number {
  return rows.reduce((a, s) => a + f(s), 0) / rows.length;
}

describe("imported vs painted", () => {
  it("scores both through one crush", async () => {
    mkdirSync(WORK, { recursive: true });
    const pal = paletteRgb();
    const lines: string[] = [];

    for (const pair of PAIRS) {
      const jsonPath = join(PUBLIC, `${pair.sheet}-${pair.dir}.json`);
      if (!existsSync(jsonPath)) {
        lines.push(`${pair.key}: no manifest — run \`npm run sprites\` first`);
        continue;
      }
      const manifest = JSON.parse(readFileSync(jsonPath, "utf8")) as SheetManifest;
      const img = await loadImage(join(PUBLIC, `${pair.sheet}-${pair.dir}.png`));
      const sheet: ImportedSheet = { manifest, image: img as unknown as CanvasImageSource };
      const imported = importedPaints([sheet]);
      expect(imported, `${pair.key}: manifest produced no playable clips`).not.toBeNull();

      const painted = withRecoil(pair.painted());
      // Compare CLIP BY CLIP, and only clips both sides author — an imported
      // sheet with six attack frames against a painted four is not a fidelity
      // difference, and averaging over it would hide one.
      const D = pair.dir;
      const clips = (Object.keys(imported![D]) as ClipName[]).filter((c) => painted[D][c]?.length);

      const shots: { label: string; img: ImageData }[] = [];
      const iStats: CellStats[] = [];
      const pStats: CellStats[] = [];
      for (const clip of clips) {
        const iFrames = imported![D][clip] ?? [];
        const pFrames = painted[D][clip] ?? [];
        const n = Math.min(iFrames.length, pFrames.length);
        for (let i = 0; i < n; i++) {
          const a = crush(iFrames[i]);
          const b = crush(pFrames[i]);
          iStats.push(censusCell(a.data, G, pal));
          pStats.push(censusCell(b.data, G, pal));
          shots.push({ label: `${clip}${i}`, img: a });
          shots.push({ label: `${clip}${i}`, img: b });
        }
      }
      expect(iStats.length, `${pair.key}: no clips in common`).toBeGreaterThan(0);

      // The premise: an imported frame is as valid as a painted one.
      for (const s of iStats) {
        expect(s.unmatched, `${pair.key}: off-palette texels after the snap`).toBe(0);
        expect(s.opaque, `${pair.key}: crushed to an empty cell`).toBeGreaterThan(20);
      }

      lines.push(
        `── ${pair.key} (${clips.join(", ")}) — ${iStats.length} frames each\n` +
          `   IMPORTED  entries ${mean(iStats, (s) => s.entries).toFixed(1)}  ` +
          `isolated ${mean(iStats, (s) => s.isolatedPct).toFixed(1)}%  ` +
          `runLen ${mean(iStats, (s) => s.runLen).toFixed(2)}\n` +
          `   PAINTED   entries ${mean(pStats, (s) => s.entries).toFixed(1)}  ` +
          `isolated ${mean(pStats, (s) => s.isolatedPct).toFixed(1)}%  ` +
          `runLen ${mean(pStats, (s) => s.runLen).toFixed(2)}`,
      );

      // Side by side, imported above painted, nearest-upscaled — atlas truth.
      const Z = 4;
      const cols = Math.min(12, shots.length / 2);
      const cw = G * Z + 4;
      const pv = createCanvas(cols * cw + 4, Math.ceil(shots.length / 2 / cols) * cw * 2 + 4);
      const pctx = pv.getContext("2d");
      pctx.fillStyle = "#14161c";
      pctx.fillRect(0, 0, pv.width, pv.height);
      pctx.imageSmoothingEnabled = false;
      shots.forEach((s, i) => {
        const pairIdx = i >> 1;
        const t = createCanvas(G, G);
        (t.getContext("2d") as unknown as CanvasRenderingContext2D).putImageData(s.img, 0, 0);
        const x = 4 + (pairIdx % cols) * cw;
        const y = 4 + Math.floor(pairIdx / cols) * cw * 2 + (i % 2) * cw;
        pctx.drawImage(t, x, y, G * Z, G * Z);
      });
      writeFileSync(join(WORK, `ab-${pair.key}.png`), pv.toBuffer("image/png"));
    }

    const report = lines.join("\n") + "\n\nTop row imported, bottom row painted, in work/ab-<name>.png\n";
    writeFileSync(join(WORK, "ab.txt"), report);
    console.log("\n" + report);
  }, 600_000);
});
