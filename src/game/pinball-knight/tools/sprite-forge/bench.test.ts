/**
 * THE CANDIDATE BENCH — nine directions, six creatures, four movements.
 *
 * ── WHY THIS REPLACED `matrix.test.ts` ──────────────────────────────────────
 *
 * The matrix bench compared four arms on ONE creature's idle head and named a
 * winner. Two things were wrong with that and both came back as feedback:
 *
 *   1. **A head crop is not enough evidence.** Sharpness that holds on a
 *      standing pose can fall apart on a run cycle, on a death sprawl, or on a
 *      creature whose materials are nothing like plate armour. So every arm is
 *      rendered here across six creatures and every clip they author, and at
 *      ACTUAL DISPLAY SIZE as well as zoomed — a sprite is judged at the size
 *      it is played at.
 *   2. **Picking the winner is not this file's job.** The noise metrics are
 *      exhausted at this quality level (the painted roster, the thing we are
 *      aiming at, scores WORSE than every arm on all of them), so a ranking
 *      derived from them is a preference wearing a measurement's clothes. This
 *      bench renders candidates and reports numbers. A human votes.
 *
 * Each arm is a coherent DESIGN POSITION, not a point in a knob sweep — the
 * best version of one idea about what makes a sprite read well. They disagree
 * about whether the mosaic is noise or texture, whether an outline is worth a
 * texel of silhouette, and whether twenty colours is a budget or a target.
 *
 *     RUN_BENCH=1 npx vitest run bench
 *
 * Writes `work/bench/`: one 1× strip per arm × creature × clip (the page that
 * displays them zooms with nearest sampling — shipping 1× pixels keeps the
 * artifact a tenth of the size and shows atlas truth either way), plus
 * `bench.json`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createCanvas, loadImage, type Canvas } from "canvas";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installSpriteTestDom, SHIPPED_GRID, bufferFor, paintAtlas } from "../../testkit/atlas-census";
import { censusCell } from "../../render/atlas-census";
import { PALETTE_HEX, PALETTE_FAMILIES } from "../../render/palette";
import { makeKnightPaints } from "../../render/cel-painter";
import { commitToGrid, type CommitOptions, type CommitResult } from "./commit";
import { hexOf } from "./palette-derive";
import { cutSheet, type CutSheet, type Sidecar } from "./sheet-cut";
import { ART_BOX, oneToOneScale } from "./manifest";
import { registerCell, crushCell } from "./register";
import { encodeIndexedPng } from "./png-indexed";

const HERE = __dirname;
const INBOX = join(HERE, "inbox");
/** The knight's RAW prep output — `inbox/` holds his COMMITTED sheets. */
const RAW = join(HERE, "work", "raw");
const OUT = join(HERE, "work", "bench");
const RUN = process.env.RUN_BENCH === "1";

const G = SHIPPED_GRID;
const PX = bufferFor(G);
const PAL = (): number[][] => PALETTE_HEX.map((h) => [(h >> 16) & 255, (h >> 8) & 255, h & 255]);
const ROT = [...PALETTE_FAMILIES.rot];

let restore = (): void => {};
beforeAll(() => { restore = installSpriteTestDom(); });
afterAll(() => { restore(); });

// ── THE CANDIDATES ──────────────────────────────────────────────────────────

interface Arm {
  key: string;
  name: string;
  /** What this arm BELIEVES. One sentence, for the voting page. */
  thesis: string;
  /** What it costs, honestly. */
  cost: string;
  opts: CommitOptions;
}

/**
 * ⚠️ ARMS ARE NOT RANKED AND THE ORDER IS NOT A PREFERENCE. `S1` is first
 * because it is what ships today and therefore the control every other arm is
 * read against, not because it is the baseline-to-beat.
 */
const ARMS: Arm[] = [
  {
    key: "S1",
    name: "Shipped",
    thesis: "The current pipeline: vote for each texel, snap to the shared dungeon palette, ban the rot ramp, flatten patches under 6 texels.",
    cost: "Skin lands on the torch ramp (gold chin) and armour on arcane (blue flecks) — the shared palette has no slots left for them.",
    opts: { ban: ROT },
  },
  {
    key: "P1",
    name: "Own palette",
    thesis: "Shipped, but the creature gets its own 20 colours instead of 20 of the dungeon's 32. Nothing else changes.",
    cost: "Three facings derive three palettes, so the atlas carries more distinct colours than a shared-palette sheet.",
    opts: { derive: 20 },
  },
  {
    key: "P2",
    name: "Own palette, wider",
    thesis: "24 colours instead of 20, and patches down to 4 texels survive. More tonal range, less flattening.",
    cost: "More entries in the atlas, and the mosaic the flattening was removing partly comes back.",
    opts: { derive: 24, maxEntries: 24, minRegion: 4 },
  },
  {
    key: "P3",
    name: "Own palette, crisp",
    thesis: "Own palette with the pre-reduce contrast boost pushed from 0.9 to 1.5 — every internal edge argues harder for its own texel.",
    cost: "Hard sharpening fragmented the helmet at 1.8 in an earlier sweep; 1.5 is near that edge.",
    opts: { derive: 20, presharpen: 1.5, minRegion: 4 },
  },
  {
    key: "P4",
    name: "Own palette, untouched",
    thesis: "No flattening, no despeckle. The position that the small patches are TEXTURE — cloth weave, hammered plate — and removing them is removing detail.",
    cost: "This is the mosaic, deliberately. It is what 'melting' was named after.",
    opts: { derive: 20, minRegion: 0, noDespeckle: true },
  },
  {
    key: "P5",
    name: "Own palette + inked edge",
    thesis: "Vote-reduced detail kept in full, plus a deliberate one-texel ink outline around the silhouette — the Ragnarok edge without the Ragnarok flattening.",
    cost: "The outline eats a texel of silhouette all round, which shows on thin limbs and weapons.",
    opts: { derive: 20, outline: true },
  },
  {
    key: "R1",
    name: "Regions, flat",
    thesis: "Decide the regions first and colour each one flat, then ink the edge. The full Ragnarok construction — flatness is the design, not a repair.",
    cost: "Internal texture is gone by construction. Plate reads as plate, not as hammered plate.",
    opts: { mode: "synth", derive: 20 },
  },
  {
    key: "R2",
    name: "Regions, fine",
    thesis: "The same region-first idea at a third of the region size, so structure is decided but small features keep their own regions.",
    cost: "Between R1 and the vote arms on everything, which may mean it is neither.",
    opts: { mode: "synth", derive: 20, synth: { regionTexels: 3, compactness: 0.25 } },
  },
  {
    key: "R3",
    name: "Regions, no edge",
    thesis: "Region-first flatness with NO authored outline, so the silhouette keeps every texel and the runtime's own shadow-side rim is the only edge.",
    cost: "Without the hard rim the figure can read soft against a busy floor — which is what the rim was added for.",
    opts: { mode: "synth", derive: 20, synth: { outline: false } },
  },
];

// ── THE SUBJECTS ────────────────────────────────────────────────────────────

interface Subject { key: string; file: string; dir: string; label: string; note: string }

/**
 * Six creatures, chosen for MATERIAL and SILHOUETTE variety rather than
 * convenience — an arm that flatters plate armour and destroys a rotting
 * zombie's texture has not been tested by three more sheets of plate armour.
 */
const SUBJECTS: Subject[] = [
  { key: "knight-S", file: "pinball_knight-S.png", dir: RAW, label: "Knight, front", note: "plate armour, skin, a gold sword — the player" },
  { key: "knight-E", file: "pinball_knight-E.png", dir: RAW, label: "Knight, side", note: "the same creature turned: thin limbs and a swung blade" },
  { key: "jester", file: "jester-S.png", dir: INBOX, label: "Jester", note: "high-chroma motley, a ruff, fine patterning" },
  { key: "zombie", file: "zombie-E.png", dir: INBOX, label: "Zombie", note: "rot green, torn cloth, deliberately mottled" },
  { key: "beaver", file: "beaver-S.png", dir: INBOX, label: "Rotortail", note: "fur — texture that is not made of hard edges" },
  { key: "frog", file: "frog-S.png", dir: INBOX, label: "Frog", note: "wet highlights on a smooth body, 268k source colours" },
];

/**
 * ⚠️ `stiltneck-E` IS NOT HERE, AND NOT BECAUSE IT LOOKED BAD.
 *
 * It fails to commit on ALL NINE arms, identically: its sidecar splits one
 * sliced band into two clips (`"cells": [[5, 5], 5, 2, 3]`), so the repack lays
 * out five rows and no gutter re-slices back to that shape — the 2-cell and
 * 3-cell rows fall under `slice.ts`'s caption filter. That is a real gap in the
 * commit path for band-splitting sidecars, it predates every arm here, and it
 * belongs to `commit.ts`'s layout rather than to any candidate. Benching a
 * creature every arm fails on measures nothing about the arms.
 */
const KNOWN_UNCOMMITTABLE = ["stiltneck-E"];

/** Which clips the voting page shows. Enough movement to judge, few enough to load. */
const SHOWN_CLIPS = ["idle", "walk", "run", "attack", "death"];

// ── metrics ─────────────────────────────────────────────────────────────────

/** Share of opaque texels in a same-colour region under 6 — the mosaic. */
function regionStats(d: Uint8ClampedArray, g: number): { meanRegion: number; mosaicPct: number } {
  const key = new Int32Array(g * g).fill(-1);
  for (let p = 0; p < g * g; p++) {
    if (d[p * 4 + 3] <= 127) continue;
    key[p] = (d[p * 4] << 16) | (d[p * 4 + 1] << 8) | d[p * 4 + 2];
  }
  const comp = new Int32Array(g * g).fill(-1);
  const sizes: number[] = [];
  for (let p = 0; p < g * g; p++) {
    if (key[p] < 0 || comp[p] >= 0) continue;
    const id = sizes.length;
    let n = 0;
    const stack = [p];
    comp[p] = id;
    while (stack.length) {
      const q = stack.pop()!;
      n++;
      const qx = q % g, qy = (q / g) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = qx + dx, ny = qy + dy;
        if (nx < 0 || ny < 0 || nx >= g || ny >= g) continue;
        const nn = ny * g + nx;
        if (comp[nn] >= 0 || key[nn] !== key[q]) continue;
        comp[nn] = id;
        stack.push(nn);
      }
    }
    sizes.push(n);
  }
  const opaque = sizes.reduce((a, b) => a + b, 0);
  if (!opaque) return { meanRegion: 0, mosaicPct: 0 };
  return {
    meanRegion: sizes.reduce((a, b) => a + b * b, 0) / opaque,
    mosaicPct: (100 * sizes.filter((n) => n < 6).reduce((a, b) => a + b, 0)) / opaque,
  };
}

function colourStats(d: Uint8ClampedArray): { sat: number; lumaSd: number } {
  let s = 0, n = 0, l = 0, l2 = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] <= 127) continue;
    const mx = Math.max(d[i], d[i + 1], d[i + 2]);
    s += mx > 0 ? (mx - Math.min(d[i], d[i + 1], d[i + 2])) / mx : 0;
    const lum = 0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2];
    l += lum; l2 += lum * lum;
    n++;
  }
  if (!n) return { sat: 0, lumaSd: 0 };
  const mean = l / n;
  return { sat: s / n, lumaSd: Math.sqrt(Math.max(0, l2 / n - mean * mean)) };
}

interface Metrics { entries: number; isolatedPct: number; mosaicPct: number; meanRegion: number; sat: number; lumaSd: number }

function score(frames: readonly ImageData[], pal: number[][]): Metrics {
  let iso = 0, mos = 0, mean = 0, sat = 0, sd = 0, w = 0;
  const entries = new Set<number>();
  for (const f of frames) {
    const st = censusCell(f.data, G, pal);
    if (!st.opaque) continue;
    const rg = regionStats(f.data, G);
    const cs = colourStats(f.data);
    iso += st.isolatedPct * st.opaque;
    mos += rg.mosaicPct * st.opaque;
    mean += rg.meanRegion * st.opaque;
    sat += cs.sat * st.opaque;
    sd += cs.lumaSd * st.opaque;
    w += st.opaque;
    for (let i = 0; i < f.data.length; i += 4) {
      if (f.data[i + 3] > 127) entries.add((f.data[i] << 16) | (f.data[i + 1] << 8) | f.data[i + 2]);
    }
  }
  if (!w) return { entries: 0, isolatedPct: 0, mosaicPct: 0, meanRegion: 0, sat: 0, lumaSd: 0 };
  return {
    entries: entries.size,
    isolatedPct: iso / w, mosaicPct: mos / w, meanRegion: mean / w,
    sat: sat / w, lumaSd: sd / w,
  };
}

// ── the shipped path, per cell ──────────────────────────────────────────────

function toCanvas(img: { width: number; height: number; data: Uint8ClampedArray }): Canvas {
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext("2d");
  const im = ctx.createImageData(img.width, img.height);
  im.data.set(img.data);
  ctx.putImageData(im, 0, 0);
  return c;
}

/**
 * A committed sheet through THE GAME'S OWN PATH.
 *
 * `oneToOneScale` + `registerCell(align, gridN)` + `crushCell` is exactly what
 * `imported-paints.ts` does at runtime, including the sheet's own palette
 * appended to the shared one. Measuring anything else would describe a path the
 * player does not take — which this pipeline has already shipped twice.
 */
function crushCommitted(c: CommitResult): { frames: ImageData[]; clips: string[] } {
  const canvas = toCanvas(c.image);
  const k = oneToOneScale(c.report.factor, G) * (PX / ART_BOX);
  const own = c.derived ? c.palette : undefined;
  const frames: ImageData[] = [];
  const clips: string[] = [];
  for (const r of c.rows) {
    for (const cell of r.cells) {
      const buf = registerCell(canvas as unknown as CanvasImageSource, cell, k, PX, PX / G, c.report.factor);
      frames.push(crushCell(buf, G, own));
      clips.push(r.clip);
    }
  }
  return { frames, clips };
}

/**
 * Frames laid out left to right at 1×. The page zooms; the pixels ship raw.
 *
 * ⚠️ CROPPED TO THE UNION BBOX OF THE WHOLE STRIP, never per frame. Most of an
 * 84×84 atlas cell is transparent, and shipping it costs the voting page four
 * times its own size in base64 — but cropping each frame to ITS OWN ink would
 * re-centre every pose and turn a walk cycle into a creature jittering on the
 * spot. One rect for the strip keeps the motion honest and still drops ~70% of
 * the bytes.
 */
function strip(frames: readonly ImageData[]): Canvas {
  let x0 = G, y0 = G, x1 = -1, y1 = -1;
  for (const f of frames) {
    for (let y = 0; y < G; y++) {
      for (let x = 0; x < G; x++) {
        if (f.data[(y * G + x) * 4 + 3] <= 127) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) { x0 = y0 = 0; x1 = y1 = G - 1; }
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const out = createCanvas(Math.max(1, frames.length) * w, h);
  const ctx = out.getContext("2d");
  frames.forEach((f, i) => {
    const t = createCanvas(G, G);
    (t.getContext("2d") as unknown as CanvasRenderingContext2D).putImageData(f, 0, 0);
    ctx.drawImage(t, x0, y0, w, h, i * w, 0, w, h);
  });
  return out;
}

/** A palette bar, one texel per entry, for the page to zoom. */
function swatches(pal: readonly (readonly number[])[]): Canvas {
  const out = createCanvas(Math.max(1, pal.length), 1);
  const ctx = out.getContext("2d");
  pal.forEach((c, i) => {
    ctx.fillStyle = hexOf(c);
    ctx.fillRect(i, 0, 1, 1);
  });
  return out;
}

/**
 * Write a canvas as an INDEXED png, falling back to node-canvas's RGBA.
 *
 * Not an optimisation for its own sake: these strips are inlined into a review
 * page as base64, which costs 4 bytes per 3, and the RGBA encoding put the
 * whole bench at 2.2 MB before a single byte of HTML. See `png-indexed.ts`.
 */
function writePng(file: string, canvas: Canvas): number {
  const w = canvas.width, h = canvas.height;
  const data = canvas.getContext("2d").getImageData(0, 0, w, h).data as unknown as Uint8ClampedArray;
  const buf = encodeIndexedPng(w, h, data) ?? canvas.toBuffer("image/png");
  writeFileSync(file, buf);
  return buf.length;
}

/** One decoded, matted, sliced subject. `cutSheet` is pure; decoding is ours. */
interface Loaded { img: { width: number; height: number; data: Uint8ClampedArray }; cut: CutSheet }

async function load(s: Subject): Promise<Loaded> {
  const sideFile = join(s.dir, s.file.replace(/\.png$/i, ".json"));
  const side: Sidecar | null = existsSync(sideFile)
    ? (JSON.parse(readFileSync(sideFile, "utf8")) as Sidecar)
    : null;
  const im = await loadImage(join(s.dir, s.file));
  const c = createCanvas(im.width, im.height);
  const ctx = c.getContext("2d");
  ctx.drawImage(im as never, 0, 0);
  const raw = ctx.getImageData(0, 0, im.width, im.height);
  const cut = cutSheet(raw.data as unknown as Uint8ClampedArray, im.width, im.height, side);
  if (cut.notes.length) console.warn(`[bench] ${s.file}: ${cut.notes.join(" / ")}`);
  return { img: { width: im.width, height: im.height, data: cut.data }, cut };
}

/** Up to `n` frames of a clip, evenly spread — not just the first few. */
function sample<T>(items: readonly T[], n: number): T[] {
  if (items.length <= n) return [...items];
  return Array.from({ length: n }, (_, i) => items[Math.round((i * (items.length - 1)) / (n - 1))]);
}

describe("sprite candidate bench", () => {
  it.runIf(RUN)("renders every candidate across every creature and clip", async () => {
    mkdirSync(OUT, { recursive: true });
    const pal = PAL();

    const missing = SUBJECTS.filter((s) => !existsSync(join(s.dir, s.file)));
    if (missing.length) {
      throw new Error(
        `[bench] missing source art: ${missing.map((m) => join(m.dir, m.file)).join(", ")}.\n` +
          `The knight's RAW sheets are not tracked — inbox/ holds his COMMITTED ones, and ` +
          `benching a commit against committed art measures it against itself. Build them:\n` +
          `    SPRITE_INBOX=${RAW} node ${join(HERE, "prep", "prep-knight.mjs")} build`,
      );
    }

    const loaded = new Map<string, Loaded>();
    for (const s of SUBJECTS) loaded.set(s.key, await load(s));

    const manifest: Record<string, unknown> = {
      grid: G,
      arms: ARMS.map(({ key, name, thesis, cost }) => ({ key, name, thesis, cost })),
      subjects: SUBJECTS.map(({ key, label, note }) => ({
        key, label, note,
        clips: [...new Set(loaded.get(key)!.cut.rows.map((r) => r.clip))],
        sourceColours: (() => {
          const d = loaded.get(key)!.img.data;
          const set = new Set<number>();
          for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 127) set.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
          return set.size;
        })(),
      })),
      cells: [] as unknown[],
      palettes: {} as Record<string, string[]>,
    };
    const cells = manifest.cells as unknown[];
    const palettes = manifest.palettes as Record<string, string[]>;

    for (const arm of ARMS) {
      for (const sub of SUBJECTS) {
        const sheet = loaded.get(sub.key)!;
        let c: CommitResult;
        try {
          c = commitToGrid(sheet.img, sheet.cut.rows, pal, arm.opts);
        } catch (e) {
          // A candidate that cannot commit a creature is a REAL result and the
          // page must say so — silently dropping the cell would show a gap that
          // reads as "not rendered yet" rather than "this arm fails here".
          cells.push({ arm: arm.key, subject: sub.key, error: String(e).slice(0, 220) });
          continue;
        }
        const { frames, clips } = crushCommitted(c);
        palettes[`${arm.key}/${sub.key}`] = c.palette.map(hexOf);
        writePng(join(OUT, `pal-${arm.key}-${sub.key}.png`), swatches(c.palette));

        for (const clip of [...new Set(clips)]) {
          const own = frames.filter((_, i) => clips[i] === clip);
          if (!own.length) continue;
          const shown = sample(own, 4);
          const file = `${arm.key}-${sub.key}-${clip}.png`;
          const bytes = writePng(join(OUT, file), strip(shown));
          cells.push({
            arm: arm.key, subject: sub.key, clip, file, frames: shown.length, bytes,
            texelH: c.report.texelH, texelW: c.report.texelW,
            ...score(own, [...pal, ...(c.derived ? c.palette : [])]),
          });
        }
      }
    }

    // ── THE ORACLE ROW: the procedural knight, authored at final resolution ──
    //
    // Not a candidate — it cannot be applied to imported art. It is here so the
    // page can show what code-authored pixels look like beside every arm, and
    // so the numbers have something absolute to sit against.
    {
      const painted = makeKnightPaints("sword");
      for (const clip of ["idle", "walk", "run", "attack"] as const) {
        const list = painted.S[clip];
        if (!list?.length) continue;
        const fr = sample(list, 4).map((f) => paintAtlas(f, G));
        const file = `ORACLE-knight-S-${clip}.png`;
        const bytes = writePng(join(OUT, file), strip(fr));
        cells.push({
          arm: "ORACLE", subject: "knight-S", clip, file, frames: fr.length, bytes,
          texelH: 0, texelW: 0, ...score(fr, pal),
        });
      }
    }

    writeFileSync(join(OUT, "bench.json"), JSON.stringify(manifest, null, 2) + "\n");

    const rendered = readdirSync(OUT).filter((f) => f.endsWith(".png")).length;
    const failed = cells.filter((c) => (c as { error?: string }).error);
    // Loud, not silent: an arm that fails on half the roster is a finding, and
    // a bench that quietly rendered fewer cells than it claims is not evidence.
    if (failed.length) console.warn(`[bench] ${failed.length} arm×subject cell(s) failed to commit`);
    expect(rendered).toBeGreaterThan(ARMS.length * SUBJECTS.length);
  }, 3_600_000);
});
