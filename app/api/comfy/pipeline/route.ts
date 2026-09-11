/**
 * Import-pipeline access for the /forge panel — cut, crush-preview, stage.
 *
 *   POST {op:"cut",   sheetB64, sidecar?}            → row/cell report, NO writes
 *   POST {op:"crush", sheetB64, sidecar}             → contact-sheet preview of the REAL crush
 *   POST {op:"stage", name, sheetB64, sidecar, overwrite?} → writes inbox/<name>.{png,json}
 *   POST {op:"keep",  character, jobId, frames}      → copies generation frames into
 *                                                      sources/<character>-<date>/ (tracked originals)
 *   POST {op:"publish"}                              → `npm run sprites`: inbox → public/sprites/
 *   GET  ?list=sprites                               → shipped sheets for the style-ref picker
 *
 * This file is the NODE EDGE, exactly like `inbox.test.ts`: it decodes PNGs
 * with node-canvas and (for `stage` only) touches the filesystem, while every
 * decision — matte, slice, label, register, crush — is the same pure function
 * the importer runs. Nothing here re-implements the pipeline; a preview that
 * drifted from `npm run sprites` would be worse than no preview.
 *
 * ⚠️ NEVER add node-only imports to files under `tools/sprite-forge/` — the
 * purity of that directory is enforced by `testkit-boundary.test.ts`. This
 * route lives in `app/`, outside the scan, which is the one place `canvas`
 * is allowed to appear.
 *
 * ⚠️ `stage` IS THE ONLY WRITE, and it writes TRACKED files — that is the
 * sanctioned import edge (drop a sheet in the inbox, run `npm run sprites`).
 * `cut` and `crush` must stay write-free so the panel can iterate freely.
 *
 * `canvas` is a devDependency loaded lazily AFTER the backendPresent() gate,
 * so the NAS container (no ~/comfy, no devDeps) 404s instead of crashing the
 * module load.
 */
import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cutSheet,
  type CutSheet,
  type Sidecar,
} from "../../../../src/game/pinball-knight/tools/sprite-forge/sheet-cut";
import type { Cell } from "../../../../src/game/pinball-knight/tools/sprite-forge/slice";
import {
  cellScalePx,
  crushCell,
  registerCell,
  sheetScale,
} from "../../../../src/game/pinball-knight/tools/sprite-forge/register";
import {
  ART_BOX,
  fitsArtBox,
  oneToOneScale,
} from "../../../../src/game/pinball-knight/tools/sprite-forge/manifest";
import { detectPixelGrid } from "../../../../src/game/pinball-knight/tools/sprite-forge/grid";
import {
  commitToGrid,
  type CommitOptions,
} from "../../../../src/game/pinball-knight/tools/sprite-forge/commit";
import { rgbHex } from "../../../../src/game/pinball-knight/tools/sprite-forge/matte";
import { rgbOfHex } from "../../../../src/game/pinball-knight/tools/sprite-forge/palette-derive";
import {
  censusCell,
  formatNoise,
  paletteRgb,
  type NoiseRow,
} from "../../../../src/game/pinball-knight/render/atlas-census";
import {
  installPalette,
  PALETTE_FAMILIES,
} from "../../../../src/game/pinball-knight/render/palette";
import {
  CAMERA_ZOOMS,
  CAMERA_ZOOM_DEFAULT,
} from "../../../../src/game/pinball-knight/constants/render";
import { backendPresent } from "../../../../src/game/pinball-knight/tools/sprite-forge/comfy/forge-config.mjs";
import {
  INTAKE_PX,
  flattenOnKey,
  letterbox,
  reframeSubject,
} from "../../../../src/game/pinball-knight/tools/sprite-forge/intake";
import { qaFrame } from "../../../../src/game/pinball-knight/tools/sprite-forge/intake-qa";
import { driftFrame, driftClip } from "../../../../src/game/pinball-knight/tools/sprite-forge/drift";

export const dynamic = "force-dynamic";

/** The rung the game ships at, as a grid size — derived, never typed out (see testkit). */
const SHIPPED_GRID = (CAMERA_ZOOMS[CAMERA_ZOOM_DEFAULT] * 3) / 2;
/** `SPRITE_PX` for a grid: the 2x identity that makes the crush an exact box. */
const bufferFor = (grid: number): number => grid * 2;

const FORGE_REL = "src/game/pinball-knight/tools/sprite-forge";
const INBOX = () => join(process.cwd(), FORGE_REL, "inbox");
const SPRITES_PUBLIC = () => join(process.cwd(), "public", "sprites");

/** inbox naming contract: `ratking` or `ratking-E`. W is never authored. */
const NAME_RE = /^[a-z0-9_]+(-[ENS])?$/;

type CanvasMod = any;

interface DecodedSheet {
  canvas: any;
  ctx: any;
  width: number;
  height: number;
  /** The raw PNG bytes as received — what `stage` writes, un-re-encoded. */
  bytes: Buffer;
}

/** Decode a base64 PNG (data-URL prefix optional) onto a node canvas. */
async function decodeSheet(mod: CanvasMod, sheetB64: string): Promise<DecodedSheet> {
  const bytes = Buffer.from(String(sheetB64).replace(/^data:image\/\w+;base64,/, ""), "base64");
  const img = await mod.loadImage(bytes);
  const canvas = mod.createCanvas(img.width, img.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);
  return { canvas, ctx, width: img.width, height: img.height, bytes };
}

/**
 * Run the pipeline's register/crush stage under a scoped `document` shim.
 *
 * `registerCell` and the engine's `crushToGrid` allocate scratch canvases via
 * `document.createElement("canvas")` — the same shim `installSpriteTestDom`
 * installs for vitest. RESTORED IN `finally`: this route shares a process with
 * the dev server's SSR, and code all over the app branches on
 * `typeof document` to detect the browser.
 */
function withDom<T>(mod: CanvasMod, fn: () => T): T {
  const g = globalThis as { document?: unknown };
  const prev = g.document;
  g.document = {
    createElement: (t: string) => (t === "canvas" ? mod.createCanvas(1, 1) : {}),
  };
  installPalette();
  try {
    return fn();
  } finally {
    g.document = prev;
  }
}

/**
 * Cut the decoded sheet and BLIT THE MATTED PIXELS BACK onto the canvas.
 *
 * The write-back is load-bearing (same note as inbox.test.ts): `registerCell`
 * samples the CANVAS, and without it every crush below runs against the
 * sheet's original opaque background.
 */
function runCut(dec: DecodedSheet, side: Sidecar | null): { src: CutSheet; warnings: string[] } {
  const raw = dec.ctx.getImageData(0, 0, dec.width, dec.height);
  const src = cutSheet(raw.data as unknown as Uint8ClampedArray, dec.width, dec.height, side);
  raw.data.set(src.data as unknown as Uint8ClampedArray);
  dec.ctx.putImageData(raw, 0, 0);

  // The documented failure modes, surfaced rather than thrown — the panel
  // shows them beside the preview instead of aborting it.
  const warnings = [...src.notes, ...(src.matte?.warnings ?? [])];
  if (side?.rows && side.rows.length !== src.rows.length) {
    warnings.push(
      `sidecar names ${side.rows.length} row(s) but the cut produced ${src.rows.length}`,
    );
  }
  return { src, warnings };
}

/** Sidecar commit options with family names resolved to palette entries (mirrors inbox.test.ts). */
function commitOpts(side: Sidecar): CommitOptions {
  if (typeof side.commit !== "object") return {};
  const { bans, ...rest } = side.commit;
  if (!bans?.length) return rest;
  const ban = bans.flatMap((f) => {
    const fam = PALETTE_FAMILIES[f];
    if (!fam) {
      throw new Error(
        `sidecar bans unknown family "${f}" — known: ${Object.keys(PALETTE_FAMILIES).join(", ")}`,
      );
    }
    return [...fam];
  });
  return { ...rest, ban: [...new Set([...(rest.ban ?? []), ...ban])] };
}

/** The one-line matte summary inbox.test.ts prints, for the crush report. */
function matteLine(src: CutSheet): string {
  const r = src.matte;
  if (!r) return "";
  return (
    `MATTE  bg ${rgbHex(r.bg)} (${(r.bgConfidence * 100).toFixed(0)}% of the border) — ` +
    `keyed ${(r.keyedPct * 100).toFixed(1)}%` +
    (r.autoKeyed.length ? `, ${r.autoKeyed.length} sealed pocket(s) opened` : "") +
    (r.enclosed.length ? `, ${r.enclosed.length} pocket(s) LEFT OPAQUE` : "") +
    "\n"
  );
}

// ── ops ─────────────────────────────────────────────────────────────────────

async function opCut(mod: CanvasMod, body: { sheetB64?: string; sidecar?: Sidecar }) {
  if (!body.sheetB64) return NextResponse.json({ error: "sheetB64 is required" }, { status: 400 });
  let dec: DecodedSheet;
  try {
    dec = await decodeSheet(mod, body.sheetB64);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `sheetB64 did not decode as an image: ${msg}` }, { status: 400 });
  }
  try {
    const { src, warnings } = runCut(dec, body.sidecar ?? null);
    return NextResponse.json({
      ok: true,
      rows: src.rows.map((r) => ({ clip: r.clip, cells: r.cells as Cell[] })),
      labels: src.labels,
      slicedRows: src.slicedRows,
      // pockets = everything the matte flagged: auto-keyed cell interiors plus
      // the ones left opaque for a human to rule on.
      matte: src.matte ? { pockets: src.matte.autoKeyed.length + src.matte.enclosed.length } : null,
      warnings,
      suggestedSidecar: { rows: src.rows.map((r) => r.clip) },
    });
  } catch (e) {
    // A cut that THREW still answers 200 — the caught text is the report.
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({
      ok: true,
      rows: [],
      labels: [],
      slicedRows: 0,
      matte: null,
      warnings: [`cut failed: ${msg}`],
      suggestedSidecar: { rows: [] },
    });
  }
}

async function opCrush(mod: CanvasMod, body: { sheetB64?: string; sidecar?: Sidecar }) {
  if (!body.sheetB64) return NextResponse.json({ error: "sheetB64 is required" }, { status: 400 });
  const side = body.sidecar;
  if (!side?.rows?.length) {
    return NextResponse.json(
      { error: "crush needs a sidecar with named rows — run cut first and label them" },
      { status: 400 },
    );
  }
  let dec: DecodedSheet;
  try {
    dec = await decodeSheet(mod, body.sheetB64);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `sheetB64 did not decode as an image: ${msg}` }, { status: 400 });
  }

  try {
    return withDom(mod, () => {
      const { src, warnings } = runCut(dec, side);
      const rows = src.rows;
      const cells: Cell[] = rows.flatMap((r) => r.cells);
      if (cells.length <= 1) {
        throw new Error(
          `sliced into ${cells.length} cell(s) — is the background transparent? ${src.notes.join(" / ")}`,
        );
      }

      // ── EXACTLY the importer's scale decision (inbox.test.ts) ─────────────
      const G = SHIPPED_GRID;
      const px = bufferFor(G);
      const pal = paletteRgb();
      const named = side.rows;
      // The LIVING rows vote on the scale; a death sprawl only clamps itself.
      const aliveCells: Cell[] = named
        ? rows.flatMap((r, i) => (named[i] === "death" ? [] : r.cells))
        : cells;
      const sdata = src.data;
      const grid = detectPixelGrid(
        { width: dec.width, height: dec.height, data: sdata },
        cells as unknown as number[][],
      );
      const gridN = grid.gridded ? grid.factor : 1;
      const oneToOne = gridN > 1 ? oneToOneScale(gridN, G) : 0;
      const fitCells = aliveCells.length ? aliveCells : cells;
      const exact = oneToOne > 0 && fitsArtBox(fitCells, oneToOne);
      const k = exact ? oneToOne * (px / ART_BOX) : sheetScale(fitCells, px);
      // ── WHOSE COLOURS THIS SHEET LANDS ON ────────────────────────────────
      //
      // Two sources, and the commit is authoritative. A sidecar may name an
      // explicit `palette`; a `commit.derive` asks the commit to CLUSTER one
      // from the sheet's own texels (README: "give the sheet its OWN N-entry
      // palette instead of spending N of the shared 32"). The preview used to
      // honour only the first, so a `derive` sidecar previewed against the
      // shared 32 and looked nothing like what `npm run sprites` would ship —
      // a preview that quietly disagrees with the pipeline is worse than none.
      //
      // So the commit runs FIRST when one is asked for, and the preview snaps
      // against the palette it actually produced. Derivation stays where it
      // belongs (after the reduce, inside commit.ts) rather than being
      // re-implemented here against pre-reduce pixels.
      let commitText = "";
      let committedPal: number[][] | null = null;
      if (side.commit) {
        try {
          const c = commitToGrid({ width: dec.width, height: dec.height, data: src.data }, rows, pal, commitOpts(side));
          commitText = `COMMIT ${c.report.verdict}\n`;
          if (c.derived) committedPal = c.palette;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          warnings.push(`commit failed: ${msg}`);
        }
      }
      const ownPal = committedPal ?? (side.palette?.length ? side.palette.map(rgbOfHex) : null);
      // A DERIVED palette replaces the shared one for this actor's atlas; an
      // explicitly-listed one is appended, which is what the runtime does.
      const snapPal = committedPal ? committedPal : ownPal ? [...pal, ...ownPal] : pal;

      // ── register + REAL crush, per cell ───────────────────────────────────
      const stats: NoiseRow[] = [];
      const previews: ImageData[] = [];
      for (let i = 0; i < cells.length; i++) {
        const buf = registerCell(
          dec.canvas as unknown as CanvasImageSource,
          cells[i],
          exact ? k : cellScalePx(cells[i], k, px),
          px,
          exact ? px / G : 1,
          exact ? gridN : 0,
        );
        const img = crushCell(buf, G, ownPal ?? undefined);
        const st = censusCell(img.data, G, snapPal);
        if (st.opaque <= 20) warnings.push(`${src.labels[i]}: crushed to an EMPTY cell`);
        if (st.unmatched > 0)
          warnings.push(`${src.labels[i]}: ${st.unmatched} off-palette texel(s) after the snap`);
        previews.push(img);
        stats.push({
          key: src.labels[i],
          entries: st.entries,
          isolatedPct: st.isolatedPct,
          runLen: st.runLen,
        });
      }

      // ── contact sheet: one canvas row per clip row, nearest-upscaled ×4 ───
      const Z = 4;
      const PAD = 6;
      const maxCells = Math.max(...rows.map((r) => r.cells.length));
      const pv = mod.createCanvas(PAD + maxCells * (G * Z + PAD), PAD + rows.length * (G * Z + PAD));
      const pctx = pv.getContext("2d");
      pctx.fillStyle = "#14161c";
      pctx.fillRect(0, 0, pv.width, pv.height);
      pctx.imageSmoothingEnabled = false;
      let fi = 0;
      rows.forEach((row, ri) => {
        row.cells.forEach((_, ci) => {
          const t = mod.createCanvas(G, G);
          (t.getContext("2d") as unknown as CanvasRenderingContext2D).putImageData(
            previews[fi++],
            0,
            0,
          );
          pctx.drawImage(t, PAD + ci * (G * Z + PAD), PAD + ri * (G * Z + PAD), G * Z, G * Z);
        });
      });

      // (the commit ran BEFORE the crush above — its palette is what these
      // previews were snapped against)

      const mean = (f: (r: NoiseRow) => number): number =>
        stats.reduce((a, r) => a + f(r), 0) / stats.length;
      const union = new Set<number>();
      previews.forEach((img) => {
        const st = censusCell(img.data, G, snapPal);
        st.counts.forEach((n, idx) => {
          if (n > 0) union.add(idx);
        });
      });
      const shape = rows.map((r) => r.cells.length).join("/");
      const report =
        `${rows.length} rows [${shape}], ${cells.length} frames at atlas ${G}\n` +
        `ROWS   ${rows.map((r) => `${r.clip}:${r.cells.length}`).join("  ")}\n` +
        `GRID   ${grid.verdict}\n` +
        `SCALE  ${exact ? `1:1 block reduce ×${gridN}` : `fitted k-centroid resample (k=${k.toFixed(3)} px/src)`}\n` +
        matteLine(src) +
        commitText +
        `${formatNoise(stats)}\n` +
        `MEAN   entries ${mean((r) => r.entries).toFixed(1)}  isolated ${mean((r) => r.isolatedPct).toFixed(1)}%  runLen ${mean((r) => r.runLen).toFixed(2)}\n` +
        `PALETTE ${union.size} entr${union.size === 1 ? "y" : "ies"} used across the sheet` +
        (committedPal
          ? ` (DERIVED palette: ${committedPal.length} entries, this sheet's own)`
          : ownPal
            ? ` (own palette: ${ownPal.length} appended)`
            : "") +
        (warnings.length ? `\n${warnings.map((w) => `⚠ ${w}`).join("\n")}` : "");

      return NextResponse.json({
        ok: true,
        previewB64: pv.toBuffer("image/png").toString("base64"),
        report,
        frames: cells.length,
      });
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

async function opStage(
  mod: CanvasMod,
  body: { name?: string; sheetB64?: string; sidecar?: Sidecar; overwrite?: boolean },
) {
  const name = String(body.name ?? "");
  if (!NAME_RE.test(name)) {
    return NextResponse.json(
      { error: `name must match ${NAME_RE} — e.g. "ratking-E"` },
      { status: 400 },
    );
  }
  if (!body.sheetB64) return NextResponse.json({ error: "sheetB64 is required" }, { status: 400 });
  if (!body.sidecar || typeof body.sidecar !== "object") {
    return NextResponse.json({ error: "sidecar is required" }, { status: 400 });
  }

  // Decode BEFORE writing: a corrupt PNG staged into a TRACKED folder would
  // break the next `npm run sprites` for whoever runs it.
  let dec: DecodedSheet;
  try {
    dec = await decodeSheet(mod, body.sheetB64);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `sheetB64 did not decode as an image: ${msg}` }, { status: 400 });
  }

  const relPng = `${FORGE_REL}/inbox/${name}.png`;
  const relJson = `${FORGE_REL}/inbox/${name}.json`;
  const absPng = join(INBOX(), `${name}.png`);
  const absJson = join(INBOX(), `${name}.json`);
  if (!body.overwrite) {
    if (existsSync(absPng)) return NextResponse.json({ error: "exists", path: relPng }, { status: 409 });
    if (existsSync(absJson)) return NextResponse.json({ error: "exists", path: relJson }, { status: 409 });
  }

  // THE sanctioned write: the import edge is "drop a sheet in the inbox".
  // Bytes as received, not re-encoded; sidecar pretty-printed in the inbox's
  // own 1-space house style.
  writeFileSync(absPng, dec.bytes);
  writeFileSync(absJson, JSON.stringify(body.sidecar, null, 1) + "\n");
  return NextResponse.json({ ok: true, pngPath: relPng, jsonPath: relJson, next: "npm run sprites" });
}

/**
 * File a finished generation under its character: copy chosen frames from
 * the gitignored work/comfy/<job>/ into sources/<character>-<date>/ — the
 * TRACKED home the repo already uses for original generated art. work/ is
 * rewritten every run and "never the only copy" (README); this op is how a
 * keeper stops living there. Copies never overwrite: an index prefix walks
 * past whatever the drop dir already holds.
 */
function opKeep(body: { character?: string; jobId?: string; frames?: unknown }) {
  const character = String(body.character ?? "");
  const jobId = String(body.jobId ?? "");
  const frames = Array.isArray(body.frames) ? body.frames.map(String) : [];
  if (!/^[a-z0-9_]+$/.test(character)) {
    return NextResponse.json({ error: "character must be a bare sheet name, e.g. frog" }, { status: 400 });
  }
  if (!/^[\w-]+$/.test(jobId)) return NextResponse.json({ error: "bad jobId" }, { status: 400 });
  if (!frames.length) return NextResponse.json({ error: "frames is required — which ones to keep" }, { status: 400 });

  const jobDir = join(process.cwd(), FORGE_REL, "work", "comfy", jobId);
  let onDisk: string[];
  try {
    onDisk = readdirSync(jobDir);
  } catch {
    return NextResponse.json({ error: `unknown job ${jobId}` }, { status: 404 });
  }
  const bad = frames.find((f) => !/^[\w.-]+\.png$/.test(f) || !onDisk.includes(f));
  if (bad) return NextResponse.json({ error: `no such frame ${bad}` }, { status: 404 });

  const date = new Date().toISOString().slice(0, 10);
  const dropRel = `${FORGE_REL}/sources/${character}-${date}`;
  const dropAbs = join(process.cwd(), FORGE_REL, "sources", `${character}-${date}`);
  mkdirSync(dropAbs, { recursive: true });
  let idx = readdirSync(dropAbs).length;
  const kept: string[] = [];
  for (const f of frames) {
    let dest = `${String(idx).padStart(2, "0")}_${f}`;
    while (existsSync(join(dropAbs, dest))) dest = `${String(++idx).padStart(2, "0")}_${f}`;
    copyFileSync(join(jobDir, f), join(dropAbs, dest));
    kept.push(dest);
    idx++;
  }
  return NextResponse.json({ ok: true, dir: dropRel, files: kept });
}

/**
 * INTAKE OPS — geometry and measurement, deliberately GPU-FREE.
 *
 * The split that makes checkpoints cheap: anything costing GPU is a MODE
 * (comfy/modes.mjs, dispatched by the generate route); anything that is
 * measurement or geometry is an op here. That is why "re-centre", "strip the
 * shelf" and "check it again" are instant and can be tried repeatedly, while
 * only the cut-out and the style pass cost model time.
 */
async function opPrep(mod: CanvasMod, body: { imageB64?: string }) {
  if (!body.imageB64) return NextResponse.json({ error: "imageB64 is required" }, { status: 400 });
  let dec: DecodedSheet;
  try {
    dec = await decodeSheet(mod, body.imageB64);
  } catch (e) {
    return NextResponse.json({ error: `did not decode as an image: ${e instanceof Error ? e.message : e}` }, { status: 400 });
  }
  const raw = dec.ctx.getImageData(0, 0, dec.width, dec.height);
  const src = { width: dec.width, height: dec.height, data: raw.data as unknown as Uint8ClampedArray };
  const { image, scale, dx, dy } = letterbox(src, INTAKE_PX);
  return NextResponse.json({
    ok: true,
    frameB64: toPng(mod, image),
    transform: { scale, dx, dy, source: [dec.width, dec.height] },
  });
}

async function opReframe(
  mod: CanvasMod,
  body: { frameB64?: string; maskB64?: string; stripShelf?: boolean; keepExtras?: boolean; subjectH?: number },
) {
  if (!body.frameB64) return NextResponse.json({ error: "frameB64 is required" }, { status: 400 });
  let dec: DecodedSheet;
  try {
    dec = await decodeSheet(mod, body.frameB64);
  } catch (e) {
    return NextResponse.json({ error: `did not decode as an image: ${e instanceof Error ? e.message : e}` }, { status: 400 });
  }
  const raw = dec.ctx.getImageData(0, 0, dec.width, dec.height);
  const src = { width: dec.width, height: dec.height, data: raw.data as unknown as Uint8ClampedArray };

  // A brushed mask REPLACES the alpha: this is how "BiRefNet ate the sword" is
  // repaired without spending the GPU again.
  if (body.maskB64) {
    try {
      const m = await decodeSheet(mod, body.maskB64);
      if (m.width === src.width && m.height === src.height) {
        const md = m.ctx.getImageData(0, 0, m.width, m.height).data;
        for (let i = 0; i < src.width * src.height; i++) src.data[i * 4 + 3] = md[i * 4] >= 128 ? 255 : 0;
      }
    } catch {
      /* an unreadable mask is ignored rather than failing the reframe */
    }
  }

  try {
    const framed = reframeSubject(src, {
      stripShelf: body.stripShelf,
      keepExtras: body.keepExtras,
      subjectH: body.subjectH,
    });
    const flat = flattenOnKey(framed.image);
    return NextResponse.json({
      ok: true,
      frameB64: toPng(mod, flat),
      bbox: framed.bbox,
      feetY: framed.feetY,
      centreX: framed.centreX,
      scale: framed.scale,
      sourceH: framed.sourceH,
      notes: framed.notes,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

async function opQa(mod: CanvasMod, body: { frameB64?: string; sourceH?: number; afterStyle?: boolean }) {
  if (!body.frameB64) return NextResponse.json({ error: "frameB64 is required" }, { status: 400 });
  let dec: DecodedSheet;
  try {
    dec = await decodeSheet(mod, body.frameB64);
  } catch (e) {
    return NextResponse.json({ error: `did not decode as an image: ${e instanceof Error ? e.message : e}` }, { status: 400 });
  }
  const raw = dec.ctx.getImageData(0, 0, dec.width, dec.height);
  const v = qaFrame(
    { width: dec.width, height: dec.height, data: raw.data as unknown as Uint8ClampedArray },
    { sourceH: body.sourceH, afterStyle: body.afterStyle },
  );
  return NextResponse.json({ ok: true, ...v });
}


/**
 * `op:"drift"` — score generated cells against their facing's master.
 *
 * The measurement half of a build. `qa` asks whether ONE frame obeys the
 * geometry contract; it cannot ask about identity, because at intake there is
 * nothing to compare against. Once a build has an approved master, "is this
 * still the same creature" stops being a judgement call and becomes a number.
 *
 * It lives here rather than in the planner script because `drift.ts` is pure
 * TypeScript in the no-node layer, and a .mjs script cannot import it without
 * dragging a build step into the generation path. GPU work is a mode;
 * measurement is a pipeline op. Every other checkpoint in this route obeys the
 * same split.
 *
 * Takes the cells of ONE clip together, so the cross-frame checks can run too —
 * a duplicate pose is invisible to any single cell.
 */
async function opDrift(
  mod: CanvasMod,
  body: { masterB64?: string; cellsB64?: string[]; clip?: string; label?: string },
) {
  if (!body.masterB64) return NextResponse.json({ error: "masterB64 is required" }, { status: 400 });
  if (!body.cellsB64?.length) {
    return NextResponse.json({ error: "cellsB64 must be a non-empty array" }, { status: 400 });
  }

  const decode = async (b64: string) => {
    const dec = await decodeSheet(mod, b64);
    const raw = dec.ctx.getImageData(0, 0, dec.width, dec.height);
    return { width: dec.width, height: dec.height, data: raw.data as unknown as Uint8ClampedArray };
  };

  let master: { width: number; height: number; data: Uint8ClampedArray };
  let cells: { width: number; height: number; data: Uint8ClampedArray }[];
  try {
    master = await decode(body.masterB64);
    cells = await Promise.all(body.cellsB64.map(decode));
  } catch (e) {
    return NextResponse.json(
      { error: `did not decode as an image: ${e instanceof Error ? e.message : e}` },
      { status: 400 },
    );
  }

  const frames = cells.map((c, i) =>
    driftFrame(c, master, { clip: body.clip, label: `${body.label ?? body.clip ?? "cell"} key ${i + 1}` }),
  );
  const clip = driftClip(cells, { clip: body.clip, label: body.label });
  // ONE verdict for the row: the worst thing anywhere in it. A row holding a
  // blocked cell is not "mostly ready" — publishing it ships that cell.
  const rank: Record<string, number> = { ready: 0, usable: 1, reject: 2 };
  const level = [...frames.map((f) => f.level), clip.level].reduce(
    (a, b) => (rank[b] > rank[a] ? b : a),
    "ready" as (typeof frames)[number]["level"],
  );

  return NextResponse.json({ ok: true, level, frames, clip });
}

/** RawImage → a base64 PNG, via a scratch canvas. */
function toPng(mod: CanvasMod, img: { width: number; height: number; data: Uint8ClampedArray }): string {
  const cv = mod.createCanvas(img.width, img.height);
  const ctx = cv.getContext("2d");
  const id = ctx.createImageData(img.width, img.height);
  id.data.set(img.data);
  ctx.putImageData(id, 0, 0);
  return cv.toBuffer("image/png").toString("base64");
}

/**
 * Publish the inbox: `npm run sprites`, the one sanctioned edge.
 *
 * That script is `FORGE_PUBLISH=1 vitest run …/sprite-forge`, and the
 * FORGE_PUBLISH gate is the whole point — the deploy gate runs the same
 * suite WITHOUT it and only measures already-committed art, because a test
 * that publishes left dirty trees and raced its own readers (see the long
 * note in inbox.test.ts). Running it from here is the same command a person
 * would type, triggered explicitly, never on a timer.
 *
 * It writes TRACKED files under public/sprites/. That is what publishing is.
 */
function opPublish() {
  return new Promise<NextResponse>((resolve) => {
    const p = spawn("npm", ["run", "sprites"], { cwd: process.cwd(), env: { ...process.env } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => {
      const tail = out.split("\n").filter((l) => l.trim()).slice(-25).join("\n");
      const published = [...out.matchAll(/public\/sprites\/([\w-]+\.png)/g)].map((m) => m[1]);
      resolve(
        NextResponse.json(
          code === 0
            ? { ok: true, published: [...new Set(published)], log: tail }
            : { error: `npm run sprites exited ${code}`, log: tail },
          { status: code === 0 ? 200 : 500 },
        ),
      );
    });
  });
}

// ── handlers ────────────────────────────────────────────────────────────────

export async function POST(req: Request) {
  if (!backendPresent()) return NextResponse.json({ error: "no backend on this machine" }, { status: 404 });
  let body: { op?: string } & Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }
  let mod: any = null;
  try {
    const importMod = new Function("p", "return import(p)");
    mod = await importMod("canvas");
  } catch {
    // canvas not available
  }
  switch (body.op) {
    case "cut":
      return opCut(mod, body as { sheetB64?: string; sidecar?: Sidecar });
    case "crush":
      return opCrush(mod, body as { sheetB64?: string; sidecar?: Sidecar });
    case "stage":
      return opStage(
        mod,
        body as { name?: string; sheetB64?: string; sidecar?: Sidecar; overwrite?: boolean },
      );
    case "keep":
      return opKeep(body as { character?: string; jobId?: string; frames?: unknown });
    case "publish":
      return opPublish();
    case "prep":
      return opPrep(mod, body as { imageB64?: string });
    case "reframe":
      return opReframe(mod, body as { frameB64?: string; maskB64?: string; stripShelf?: boolean });
    case "qa":
      return opQa(mod, body as { frameB64?: string; sourceH?: number; afterStyle?: boolean });
    case "drift":
      return opDrift(mod, body as { masterB64?: string; cellsB64?: string[]; clip?: string; label?: string });
    default:
      return NextResponse.json({ error: `unknown op "${body.op}" — cut | crush | stage | keep | prep | reframe | qa | drift` }, { status: 400 });
  }
}

export async function GET(req: Request) {
  if (!backendPresent()) return NextResponse.json({ error: "no backend on this machine" }, { status: 404 });
  const url = new URL(req.url);
  if (url.searchParams.get("list") === "sprites") {
    let files: string[] = [];
    try {
      files = readdirSync(SPRITES_PUBLIC()).filter((f) => /\.png$/i.test(f)).sort();
    } catch {
      /* no sprites dir — empty list, not an error */
    }
    return NextResponse.json({
      sprites: files.map((f) => ({ name: f.replace(/\.png$/i, ""), url: `/sprites/${f}` })),
    });
  }
  return NextResponse.json({ error: "unknown query — GET ?list=sprites" }, { status: 400 });
}
