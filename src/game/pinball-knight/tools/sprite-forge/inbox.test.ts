/**
 * SPRITE INBOX — drop sheets in a folder, get scored game-ready frames.
 *
 *     cp mysheet.png tools/sprite-forge/inbox/ratking-E.png
 *     npm run sprites
 *
 * Reads every PNG in `tools/sprite-forge/inbox/`, slices each into frames, puts
 * them on the painters' registration contract, runs them through the REAL crush,
 * censuses the result against the painted roster, and writes both the frames and
 * a nearest-upscaled preview to `tools/sprite-forge/work/<name>/`.
 *
 * Nothing here talks to a network. There is no generation step and no API key.
 *
 * ── WHERE THE PIPELINE ACTUALLY LIVES ──
 *
 * Slicing (`slice.ts`), matting (`matte.ts`), labelling and registration are
 * plain functions over pixel buffers, with no filesystem and no node-canvas
 * import. This file is only the NODE EDGE: it finds the files, decodes them,
 * and writes the output. A browser refiner drives the same functions with the
 * same arguments, which is the only way "what the tool shows" and "what CI
 * scores" can be guaranteed to agree.
 *
 * ── FILE NAMING ──
 *
 *   ratking-E.png   → creature "ratking", facing E (true side profile)
 *   ratking-S.png   → facing S (toward camera).  N = away.
 *   ratking.png     → creature "ratking", facing E, the default
 *
 * W is never authored: the engine draws it as E with a negative texture repeat.
 *
 * ── WHY IT IS IN TYPESCRIPT AND NOT THE PYTHON SCRIPT IT REPLACES ──
 *
 * The Python importer needed a venv (PEP 668 blocks system installs here), PIL,
 * numpy and scipy, and it carried its OWN COPY of the 32-colour palette — which
 * would go stale the first time the palette moved and report confident nonsense.
 * This shares the game's real palette, the real crush and the real census, so
 * what it measures is what will ship.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createCanvas, loadImage } from "canvas";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { installSpriteTestDom, SHIPPED_GRID, bufferFor } from "../../testkit/atlas-census";
import { censusCell, declaredSet, formatNoise, paletteRgb, type NoiseRow } from "../../render/atlas-census";
import { type Cell } from "./slice";
import { cutSheet, type Sidecar } from "./sheet-cut";
import { cellScalePx, crushCell, registerCell, sheetScale } from "./register";
import { parseName, unknownClips } from "./labels";
import { detectPixelGrid } from "./grid";
import { commitToGrid, type CommitOptions } from "./commit";
import { driftRow, gaitSignals } from "./drift";
import type { QaCheck } from "./intake-qa";
import { rgbHex } from "./matte";
import { ART_BOX, fitsArtBox, oneToOneScale, type SheetManifest } from "./manifest";
import { PALETTE_FAMILIES } from "../../render/palette";
import { hexOf, rgbOfHex } from "./palette-derive";

const ROOT = __dirname;
const INBOX = process.env.SPRITE_INBOX ?? join(ROOT, "inbox");
const WORK = process.env.SPRITE_WORK ?? join(ROOT, "work");
/**
 * Where the GAME reads imported art from.
 *
 * `work/` is a review directory — it holds crushed frames at one rung and a
 * contact sheet, both for looking at. What ships is the MATTED SOURCE plus its
 * cell rects, because the crush has to happen at runtime against whatever
 * camera rung the player is on. See `manifest.ts`.
 */
const PUBLIC = process.env.SPRITE_PUBLIC ?? join(ROOT, "..", "..", "..", "..", "..", "public", "sprites");
/** Authoring run (`npm run sprites`) rather than a measurement run. */
const PUBLISH = !!process.env.FORGE_PUBLISH;

/** Painter roster reference, measured at the shipped rung. */
const ROSTER = { entries: 20.1, isolatedPct: 22.5, runLen: 1.82 };

/**
 * ROWS THAT ALREADY SHIP WITH DRIFTING RECTS — a backlog, not an exemption.
 *
 * Each entry is a row a player can currently watch slide sideways or bob as it
 * animates, because its rects came from `equalCells` and therefore sit on a
 * uniform column instead of on the figure. `driftRow` (drift.ts) measures it;
 * this list is what keeps the gate from failing the run for art that was
 * already broken before the gate existed.
 *
 * ⚠️ THE LIST ONLY SHRINKS. Adding to it is not a fix — it is a decision to
 * ship a visibly sliding sprite. Removing an entry means the sheet was re-cut
 * ink-tight, which is what `commit.ts` does for free. Same shape and same
 * reasoning as `ALIASED` in mislabel.test.ts.
 *
 * `brute-S` is deliberately ABSENT even though it was the worst offender
 * measured (walk sweep 0.433, a perfectly monotone ramp across four frames):
 * it was re-cut through `commit.ts` in this same wave and now scores 0.002 on
 * the same source frames. That is the proof the rest of this list is fixable
 * without regenerating anything.
 */
const KNOWN_SWEEP: readonly string[] = [
  "beaver-E idle", "beaver-E walk", "beaver-E attack",
  "beaver-S idle", "beaver-S walk", "beaver-S attack",
  "compass-E walk", "compass-N walk", "compass-S walk",
  "jester-S idle", "jester-S walk", "jester-S stumble",
  "stiltneck-E attack", "stiltneck-S walk", "stiltneck-S attack",
  "zombie-E idle", "zombie-E walk",
  // These four fail `grounded` rather than `centred` — the vertical twin. Every
  // cell in the band shares its bottom edge, so `registerCell` grounds the band
  // and any frame whose feet fall short of it floats. zombie-E's death row is
  // 20px out, which at its scale is most of a boot.
  "stiltneck-E death", "zombie-E attack", "zombie-E stumble", "zombie-E death",
  "croaker-S walk",
];

let restore = (): void => {};
beforeAll(() => { restore = installSpriteTestDom(); });
afterAll(() => { restore(); });

/** Sidecar commit options with family names resolved to palette entries. */
function commitOpts(side: Sidecar): CommitOptions {
  if (typeof side.commit !== "object") return {};
  const { bans, ...rest } = side.commit;
  if (!bans?.length) return rest;
  const ban = bans.flatMap((f) => {
    const fam = PALETTE_FAMILIES[f];
    if (!fam) throw new Error(`sidecar bans unknown family "${f}" — known: ${Object.keys(PALETTE_FAMILIES).join(", ")}`);
    return [...fam];
  });
  return { ...rest, ban: [...new Set([...(rest.ban ?? []), ...ban])] };
}

/**
 * The `scale` the shipped manifest should carry: the sidecar's if set, else
 * whatever the already-published manifest carries. Returns a spread-ready
 * fragment so an absent scale stays ABSENT rather than becoming `scale: null`.
 */
function scaleFor(side: Sidecar | null, publishedPath: string): { scale: number } | null {
  if (typeof side?.scale === "number") return { scale: side.scale };
  try {
    const prev = JSON.parse(readFileSync(publishedPath, "utf8")) as SheetManifest;
    if (typeof prev.scale === "number") return { scale: prev.scale };
  } catch {
    /* first publish — nothing to carry */
  }
  return null;
}

describe("sprite inbox", () => {
  it("processes every sheet in the inbox", async () => {
    if (!existsSync(INBOX)) mkdirSync(INBOX, { recursive: true });
    const sheets = readdirSync(INBOX).filter((f) => /\.png$/i.test(f)).sort();

    if (sheets.length === 0) {
      console.log(
        `\nInbox is empty (${INBOX}).\n` +
          `Drop sheets in as <name>-<S|N|E>.png — e.g. ratking-E.png — and run again.\n`,
      );
      return;
    }

    const G = SHIPPED_GRID;
    const px = bufferFor(G);
    const pal = paletteRgb();
    const summary: string[] = [];
    /** Crushes that threw. Reported together at the end — see the catch below. */
    const commitFailures: string[] = [];
    /** Every row's sweep/ground numbers, for the report. */
    const driftLines: string[] = [];
    /** Rows whose rects do not sit on the ink. Asserted together at the end. */
    const driftFails: string[] = [];

    for (const file of sheets) {
      const { name, dir } = parseName(file);
      // ── ONE LOADER, shared with the bench. See `source-load.ts`. ──────────
      //
      // Matte, slice, honour the sidecar's cell counts, name the rows. The
      // loader RETURNS its problems rather than throwing them, so this file can
      // turn them into `expect` failures — a bad sheet must stop a publish —
      // while the bench prints them and keeps comparing the other creatures.
      const sideFile = join(INBOX, file.replace(/\.png$/i, ".json"));
      const side: Sidecar | null = existsSync(sideFile)
        ? (JSON.parse(readFileSync(sideFile, "utf8")) as Sidecar)
        : null;
      const sheet = await loadImage(join(INBOX, file));
      const sc = createCanvas(sheet.width, sheet.height);
      const sctx = sc.getContext("2d");
      sctx.drawImage(sheet, 0, 0);
      const raw = sctx.getImageData(0, 0, sheet.width, sheet.height);
      const src = cutSheet(raw.data as unknown as Uint8ClampedArray, sheet.width, sheet.height, side);
      const sdata = src.data;
      // ⚠️ WRITE THE KEYED PIXELS BACK. `registerCell` blits from this CANVAS,
      // not from the array — without this every measurement below runs on the
      // sheet's original opaque background.
      raw.data.set(sdata as unknown as Uint8ClampedArray);
      sctx.putImageData(raw, 0, 0);
      expect(src.notes, `${file}: ${src.notes.join(" / ")}`).toEqual([]);
      const found = src.rows.flatMap((r) => r.cells).length;
      expect(found, `${file}: sliced into ${found} cell(s) — is the background transparent?`)
        .toBeGreaterThan(1);

      // A declared rect with no ink under it means the sidecar and the PNG came
      // from different runs — a stale `rects` block silently publishes empty
      // frames, the same disappearing-sprite failure from the other direction.
      if (side?.rects) {
        const empty: string[] = [];
        src.rows.forEach((r, ri: number) =>
          r.cells.forEach((c: Cell, ci: number) => {
            let ink = 0;
            for (let y = Math.max(0, c[1]); y <= Math.min(sheet.height - 1, c[3]); y++)
              for (let x = Math.max(0, c[0]); x <= Math.min(sheet.width - 1, c[2]); x++)
                if (sdata[(y * sheet.width + x) * 4 + 3] > 8) ink++;
            if (ink === 0) empty.push(`row ${ri} cell ${ci} [${c.join(",")}]`);
          }),
        );
        expect(empty, `${file}: declared rects with no ink under them — is the sidecar stale?`).toEqual([]);
      }

      const r = src.matte;
      const matteLine = r
        ? `MATTE  bg ${rgbHex(r.bg)} (${(r.bgConfidence * 100).toFixed(0)}% of the border) — ` +
          `keyed ${(r.keyedPct * 100).toFixed(1)}%` +
          (r.autoKeyed.length ? `, ${r.autoKeyed.length} sealed pocket(s) opened` : "") +
          (r.enclosed.length ? `, ${r.enclosed.length} pocket(s) LEFT OPAQUE` : "") + "\n" +
          r.warnings.map((x: string) => `⚠ ${x}`).join("\n") + (r.warnings.length ? "\n" : "")
        : "";

      const rows: { clip: string; cells: Cell[] }[] = src.rows;
      const named = side?.rows;
      const labels = src.labels;
      const cells: Cell[] = rows.flatMap((r) => r.cells);
      const shape = rows.map((r) => r.cells.length).join("/");

      // The LIVING rows vote on the scale; a death sprawl only clamps itself.
      // Without sidecar names every row is "alive" — same rule as aliveScale.
      const aliveCells: Cell[] = named
        ? rows.flatMap((r, i) => (named[i] === "death" ? [] : r.cells))
        : cells;
      // THE GATE — is this art reducible, or only resamplable? Measured on the
      // MATTED pixels (`img.data` was written back above), over the sliced
      // cells so the flat background cannot dilute the sample.
      const grid = detectPixelGrid(
        { width: sheet.width, height: sheet.height, data: sdata },
        cells as unknown as number[][],
      );

      // ── THE SCALE, MIRRORING `importedPaints` EXACTLY.
      //
      // ⚠️ This used to be `sheetScale` unconditionally, and that made the whole
      // report describe a path the game no longer takes. A committed sheet is
      // built so one authored pixel lands on one atlas texel; measuring it at
      // the FITTED scale re-introduced the fractional resample the commit exists
      // to remove, and censused a 20-entry sheet at 29.4 entries. The forge has
      // to run the shipped decision, not a differently-shaped one.
      //
      // `oneToOneScale` is in ART UNITS per source pixel; `sheetScale` is in
      // DEVICE px per source pixel, so the conversion is the same `px/ART_BOX`
      // unit `cellPaint` applies.
      const gridN = grid.gridded ? grid.factor : 1;
      const oneToOne = gridN > 1 ? oneToOneScale(gridN, G) : 0;
      const fitCells = aliveCells.length ? aliveCells : cells;
      const exact = oneToOne > 0 && fitsArtBox(fitCells, oneToOne);
      if (oneToOne > 0 && !exact) {
        summary.push(
          `⚠ ${file}: has a ×${gridN} grid but is too large to import 1:1 at atlas ${G} — ` +
            `measured on the fitted resample instead. Re-commit it smaller to keep 1:1.`,
        );
      }
      const k = exact ? oneToOne * (px / ART_BOX) : sheetScale(fitCells, px);
      // ⚠️ PER FACING, NOT PER CREATURE. This `rmSync` clears the run's own
      // stale output, and while the directory was `work/<name>` the two facings
      // of a two-sheet creature shared it: `pinball_knight-N` was processed
      // first (readdir order), then `pinball_knight-S` deleted everything N had
      // just written. The committed sheet the run tells you to promote is
      // written here, so only one of the two ever existed to promote — and the
      // frame dumps carry a `<dir>-` prefix, which made the survivor look like
      // a complete creature rather than half of one.
      // ── THIS SHEET'S OWN COLOURS, if it declared any ──────────────────────
      //
      // Appended to the shared palette rather than replacing it, exactly as the
      // runtime does (`SheetBuildOptions.sheetPalette`) — the forge has to
      // measure the decision the game makes, not a differently-shaped one.
      const ownPal = side?.palette?.length ? side.palette.map(rgbOfHex) : null;
      const snapPal = ownPal ? [...pal, ...ownPal] : pal;

      const outDir = join(WORK, `${name}-${dir}`);
      rmSync(outDir, { recursive: true, force: true });
      mkdirSync(outDir, { recursive: true });

      const stats: NoiseRow[] = [];
      const previews: ImageData[] = [];
      for (let i = 0; i < cells.length; i++) {
        // Blit from the CANVAS, not the decoded image: after matting they
        // differ, and the image still has its opaque background.
        const buf = registerCell(
          sc as unknown as CanvasImageSource,
          cells[i],
          exact ? k : cellScalePx(cells[i], k, px),
          px,
          exact ? px / G : 1,
          exact ? gridN : 0,
        );
        const bctx = buf.getContext("2d");
        if (!bctx) throw new Error("[ingest] no 2D context for the cel buffer");
        const declared = declaredSet(bctx.getImageData(0, 0, px, px).data, snapPal);

        const img = crushCell(buf, G, ownPal ?? undefined);
        const st = censusCell(img.data, G, snapPal);
        expect(st.opaque, `${file} ${labels[i]}: crushed to an EMPTY cell`).toBeGreaterThan(20);
        expect(st.unmatched, `${file} ${labels[i]}: off-palette texels after the snap`).toBe(0);

        const cel = createCanvas(G, G);
        (cel.getContext("2d") as unknown as CanvasRenderingContext2D).putImageData(img, 0, 0);
        writeFileSync(join(outDir, `${dir}-${labels[i]}.png`), cel.toBuffer("image/png"));
        previews.push(img);
        stats.push({
          key: labels[i], entries: st.entries, isolatedPct: st.isolatedPct, runLen: st.runLen,
          invented: st.counts.reduce((n, c, j) => n + (c > 0 && !declared.has(j) ? 1 : 0), 0),
        });
      }

      // Nearest-upscaled contact sheet — atlas truth, never a smoothed preview.
      const Z = 5;
      const cols = Math.min(8, previews.length);
      const pv = createCanvas(cols * (G * Z + 6) + 6, Math.ceil(previews.length / cols) * (G * Z + 6) + 6);
      const pctx = pv.getContext("2d");
      pctx.fillStyle = "#14161c";
      pctx.fillRect(0, 0, pv.width, pv.height);
      pctx.imageSmoothingEnabled = false;
      previews.forEach((img, i) => {
        const t = createCanvas(G, G);
        (t.getContext("2d") as unknown as CanvasRenderingContext2D).putImageData(img, 0, 0);
        pctx.drawImage(t, 6 + (i % cols) * (G * Z + 6), 6 + Math.floor(i / cols) * (G * Z + 6), G * Z, G * Z);
      });
      writeFileSync(join(outDir, "preview.png"), pv.toBuffer("image/png"));

      // ── SHIP THE MATTED SOURCE, not the crushed frames.
      //
      // `sc` is the sheet after keying. Written at full resolution with the cell
      // rects beside it, so the game can scale each cell into the art box and
      // crush it at the rung the player is actually on — all five of them.
      //
      // ⚠️ ONLY WHEN ASKED. Publishing is an AUTHORING action and this is a
      // TEST FILE, so a plain `vitest run` used to rewrite tracked art under
      // `public/sprites/` as a side effect of measuring it. Two costs, both
      // paid for real:
      //
      //   · a green run left a dirty tree that looked like someone's unfinished
      //     art, and `deploy.sh` ships the WORKING TREE.
      //   · it RACED the rest of the suite. `published.test.ts` reads the same
      //     PNGs, vitest shards run in parallel, and a reader landing mid-write
      //     gets `error while reading from input stream` from node-canvas. It
      //     aborted two deploys of this very change, and the first time it was
      //     dismissed as flaky because a retry passed.
      //
      // `npm run sprites` sets FORGE_PUBLISH; the deploy gate does not, and
      // then this file only MEASURES the art that is already committed.
      // Hashed BEFORE the write and from the same buffer that is written, so
      // the tag can never describe a different PNG than the one on disk.
      const png = sc.toBuffer("image/png");
      const hash = createHash("sha256").update(png).digest("hex").slice(0, 12);
      if (PUBLISH) {
        mkdirSync(PUBLIC, { recursive: true });
        writeFileSync(join(PUBLIC, `${name}-${dir}.png`), png);
      }
      const manifest: SheetManifest = {
        name, dir: dir as SheetManifest["dir"],
        image: `/sprites/${name}-${dir}.png`,
        source: [sheet.width, sheet.height],
        // ⚠️ THE CACHE-BUSTING TAG, AND IT IS NOT OPTIONAL IN PRACTICE.
        //
        // `nginx.conf` serves every PNG `max-age=1y, immutable`, so a returning
        // player's browser does not even REVALIDATE this file — and until this
        // line existed the publisher never wrote a hash, so `versioned()` fell
        // back to the sheet's DIMENSIONS. A re-export at the same 1024x1024
        // therefore kept the same URL, and the loader's size check (which is
        // the other half of the defence) saw two matching sizes and passed the
        // stale image straight through. The player then gets a FRESH sidecar
        // cut against a YEAR-OLD image: the new rects land on the old art.
        //
        // Every published sheet was in that state (41 of 43 manifests carried
        // no hash; only mario's was ever written, by hand, after it bit).
        // `published.test.ts` now fails a manifest whose hash does not match
        // its own PNG, so this cannot silently go missing again.
        hash,
        // The measured lattice, so the RUNTIME can choose between an exact
        // block reduce and a resample without re-measuring 1.6M pixels on every
        // boot. Omitted when there is none, so the field's presence means
        // "this sheet can import 1:1" and nothing weaker.
        ...(grid.gridded ? { grid: grid.factor } : {}),
        // Sidecar wins; otherwise a scale someone already shipped survives the
        // re-run. Building this object fresh every run is what used to delete
        // every hand-set scale in public/sprites (see the Sidecar docs above).
        ...(scaleFor(side, join(PUBLIC, `${name}-${dir}.json`)) ?? {}),
        // The sheet's own palette, so the runtime can append it to the shared
        // one for this actor's atlas. Absent means "shared palette", which is
        // every sheet committed before 2026-08-04.
        ...(side?.palette?.length ? { palette: side.palette } : {}),
        // The art faces the opposite of `dir` and must draw flipped — declared
        // in the sidecar, honoured by imported-paints. See docs/FACING_STANDARD.md.
        ...(side?.mirror ? { mirror: true } : {}),
        rows: rows.map((r, ri) => ({ clip: named?.[ri] ?? `row${ri}`, cells: r.cells })),
      };
      if (PUBLISH) {
        writeFileSync(join(PUBLIC, `${name}-${dir}.json`), JSON.stringify(manifest, null, 1) + "\n");
      }

      // ── DO THE RECTS SIT ON THE INK? ────────────────────────────────────
      //
      // `drift.ts` existed for a day and was reachable only from the panel
      // (`app/api/comfy/pipeline/route.ts` opDrift). Nothing in the PUBLISH
      // path imported it, which is exactly how the brute shipped a walk row
      // whose figure swept 43% of a cell width across four frames: the forge
      // sliced it, the census scored it, `importedPaints` packed it and the
      // animator played it. Every stage did its job on rects that were wrong.
      //
      // It runs HERE — on the matted sheet and the rects, before registration
      // — because `registerCell` re-centres every cell and is therefore the
      // step that HIDES this. A registered cel always looks centred; it just
      // took its neighbours' offsets with it.
      //
      // `equalised` names the likely cause when it fires. It is deliberately
      // not a gate of its own — see the docblock on `CutSheet.equalised`.
      for (const row of manifest.rows) {
        if (!Array.isArray(row.cells) || row.cells.length < 2) continue;
        const v = driftRow(
          { width: sheet.width, height: sheet.height, data: sdata },
          row.cells,
          { clip: row.clip, label: `${name}-${dir} ${row.clip}` },
        );
        // Gait is INSTRUMENTATION, not a gate — see gaitSignals' docblock for
        // the calibration that refuted the gate. It rides the same line so a
        // regenerated walk can be compared against the sway it replaced.
        const gaitTag = row.clip === "walk" || row.clip === "run"
          ? `  gait peak ${gaitSignals({ width: sheet.width, height: sheet.height, data: sdata }, row.cells).peak.toFixed(2)}`
          : "";
        driftLines.push(`  ${(name + "-" + dir).padEnd(18)} ${row.clip.padEnd(8)} ${v.checks.map((c: QaCheck) => `${c.id} ${c.value}`).join("  ")}${gaitTag}`);
        const hard = v.checks.filter((c: QaCheck) => !c.pass && !c.soft);
        if (hard.length) {
          driftFails.push(
            `${name}-${dir} ${row.clip}: ${hard.map((c: QaCheck) => `${c.id} = ${c.value} (want ${c.want})`).join("; ")}` +
              (src.equalised.length ? `\n      this sheet used equalCells for: ${src.equalised.join(", ")}` : ""),
          );
        }
      }

      // ── THE GRID COMMIT, when the sidecar asks for one.
      //
      // Written to `work/`, never to `inbox/`. Promoting it is one copy the
      // artist makes after LOOKING at it, because the commit evicts colours and
      // an eviction nobody saw is how a creature quietly loses its costume.
      let commitLine = "";
      // ── ONE SHEET'S CRUSH MUST NOT ABORT THE OTHER SIX ──────────────────
      //
      // The commit writes to `work/` for manual promotion; it is NOT the path
      // the game reads. `public/sprites/` was already written above. So a
      // throw in here used to cost far more than the crush it failed: it
      // aborted the RUN, and every sheet after the failing one never
      // published at all.
      //
      // That is precisely how the knight's art died. `commitToGrid` threw on
      // his E sheet, S and N never got their manifests, and someone
      // hand-copied the inbox sidecars into `public/sprites/` to move on —
      // which loads as `undefined` and drops the player to the painter in
      // silence. A batch that stops on its first bad item invites exactly
      // that kind of manual repair.
      //
      // Collected and asserted after the loop instead: every sheet publishes,
      // and the run still goes RED with all the failures named at once.
      if (side?.commit) try {
        const copts = commitOpts(side);
        const c = commitToGrid(
          { width: sheet.width, height: sheet.height, data: sdata },
          manifest.rows,
          pal,
          copts,
        );
        // Prove the claim rather than printing it: a committed sheet that does
        // not pass the gate it was built to pass is a bug, and it must stop the
        // run here rather than be discovered on load.
        const cg = detectPixelGrid(c.image, c.rows.flatMap((r) => r.cells) as unknown as number[][]);
        expect(cg.gridded, `${file}: the COMMITTED sheet still fails the gate — ${cg.verdict}`).toBe(true);
        expect(cg.factor, `${file}: committed at ×${c.report.factor} but the gate reads ×${cg.factor}`)
          .toBe(c.report.factor);

        const cc = createCanvas(c.image.width, c.image.height);
        const cctx = cc.getContext("2d");
        const cimg = cctx.createImageData(c.image.width, c.image.height);
        cimg.data.set(c.image.data as unknown as Uint8ClampedArray);
        cctx.putImageData(cimg, 0, 0);
        const cname = `${name}-${dir}.png`;
        writeFileSync(join(outDir, cname), cc.toBuffer("image/png"));
        // ⚠️ NO `cells` OVERRIDE on a committed sheet, deliberately — but the
        // exact `rects` ARE written, and they are not the same thing.
        //
        // `equalCells` divides a row into N EQUAL columns, which is right for a
        // ruled sheet and destroys a committed one: the cell stops being ink-
        // tight, so its width stops being a whole number of blocks (measured,
        // 195px against a ×8 lattice) and the 1:1 reduce degrades to a
        // fractional resample — the exact defect the commit removes.
        //
        // `rects` are the repack's OWN output, ink-tight and lattice-aligned by
        // construction, so declaring them re-derives nothing and loses nothing.
        // Without them the promoted sheet is sliced from scratch a second time
        // and hits the same blank-column defect the first slice did: the
        // knight's E sheet came back with a bare sword blade as a frame both
        // times. The `commit` block is carried too — a promoted sheet that lost
        // it re-publishes UNCOMMITTED on the next run, 43,000 colours deep and
        // with no `grid`, which is exactly how the player's sprite silently
        // reverted to soft art once already.
        writeFileSync(
          join(outDir, `${name}-${dir}.json`),
          JSON.stringify(
            {
              rows: manifest.rows.map((r) => r.clip),
              rects: c.rows.map((r) => r.cells),
              ...(side.commit !== undefined ? { commit: side.commit } : {}),
              // Without this the promoted sheet is measured against the shared
              // palette it is no longer on — see `Sidecar.palette`.
              ...(c.derived ? { palette: c.palette.map(hexOf) } : {}),
              ...(side.matte ? { matte: side.matte } : {}),
              ...(side.scale !== undefined ? { scale: side.scale } : {}),
              // A promoted sheet that loses its mirror publishes facing the
              // wrong way again — same survival rule as `commit` above.
              ...(side.mirror ? { mirror: true } : {}),
            },
            null,
            1,
          ) + "\n",
        );
        commitLine =
          `COMMIT ${c.report.verdict}\n` +
          `       GATE re-measured on the committed sheet: ${cg.verdict}\n` +
          `       promote with:  cp ${join(outDir, cname)} ${join(INBOX, cname)} && ` +
          `cp ${join(outDir, `${name}-${dir}.json`)} ${join(INBOX, `${name}-${dir}.json`)}\n`;
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        commitFailures.push(`${name}-${dir}: ${why}`);
        commitLine = `⚠ COMMIT FAILED — this sheet published UNCRUSHED; the game still gets it\n  ${why}\n`;
      }

      const mean = (f: (r: NoiseRow) => number): number => stats.reduce((a, r) => a + f(r), 0) / stats.length;
      const iso = mean((r) => r.isolatedPct);
      const run = mean((r) => r.runLen);
      const verdict =
        run > ROSTER.runLen && iso < ROSTER.isolatedPct ? "BETTER than the painted roster"
          : iso < 40 ? "COMPETITIVE — inside the roster's range"
            : "WORSE than the painted roster — too busy for this crush";
      const unknown = unknownClips(named);
      // ── THE GATE THAT SHIPS A PERFECT REPORT AND NO ART ──
      //
      // `importedPaints` returns null when the facing it falls back to has no
      // `idle` — that is where `withRecoil` derives stagger and wake from, and
      // where the animator lands for any clip the actor does not author. The
      // whole sheet is then dropped and the monster keeps its painter, with a
      // COMPETITIVE verdict sitting in this report saying it shipped. That is
      // exactly what happened to the zombie: six rows, 24 frames, published to
      // public/sprites, and never once drawn.
      const noIdle = named && !named.includes("idle");

      summary.push(
        `\n═══ ${name} (${dir}) — ${rows.length} rows [${shape}], ${cells.length} frames\n` +
          `GRID   ${grid.verdict}\n` +
          commitLine +
          matteLine +
          (named
            ? unknown.length
              ? `⚠ not ClipNames the animator packs: ${unknown.join(", ")}\n`
              : ""
            : `⚠ no row names. Write ${file.replace(/\.png$/i, ".json")}:\n` +
              `    { "rows": [${rows.map((_, i) => `"row${i}"`).join(", ")}] }\n`) +
          (noIdle
            ? `⚠ NO "idle" ROW — unless another facing of ${name} authors one, the game will\n` +
              `  DROP this whole sheet and keep the painter. Name the calmest cycle "idle".\n`
            : "") +
          `${formatNoise(stats)}\n` +
          `MEAN   entries ${mean((r) => r.entries).toFixed(1)}  isolated ${iso.toFixed(1)}%  runLen ${run.toFixed(2)}\n` +
          `ROSTER entries ${ROSTER.entries}  isolated ${ROSTER.isolatedPct}%  runLen ${ROSTER.runLen}\n` +
          `VERDICT: ${verdict}\n` +
          `→ ${outDir}  (frames + preview.png)`,
      );
    }
    // Written as well as logged: vitest swallows console output unless a test
    // fails, so the one artifact you actually want to read after a run was the
    // one you could not see.
    if (driftLines.length) {
      summary.push(
        `\n=== RECT DRIFT — does the figure hold its place across each row?\n` +
          `    sweep = how far it travels × how monotonically it does it. A ramp\n` +
          `    means the sprite slides sideways while the creature does not move.\n` +
          driftLines.join("\n"),
      );
    }
    writeFileSync(join(WORK, "report.txt"), summary.join("\n").replace(/\[[0-9;]*m/g, ""));
    console.log(summary.join("\n"));

    // Deferred to here on purpose: every sheet has published by now, so failing
    // the run costs nobody their art — which is the entire point of collecting
    // these rather than throwing where they happen.
    expect(
      commitFailures,
      `the crush threw on ${commitFailures.length} sheet(s). Their art IS published, ` +
        `uncrushed, so the game has them — but they stay soft until this is fixed:\n  ` +
        commitFailures.join("\n  "),
    ).toEqual([]);

    // ── RECT DRIFT, with the backlog pinned rather than waived ─────────────
    //
    // `KNOWN_SWEEP` is the art that already shipped with this defect. It is a
    // BACKLOG, not an exemption: each entry is a row a player can currently see
    // sliding, and the list only shrinks. Nothing new may join it without a
    // deliberate edit here, which is the point — the same shape as `ALIASED` in
    // mislabel.test.ts.
    //
    // Why a pinned list instead of just failing: eight published sidecars use
    // `cells` today and six of them predate the gate. Failing the run outright
    // would block every publish until all six are re-cut, which is how a gate
    // gets deleted instead of satisfied.
    const fresh = driftFails.filter((f) => !KNOWN_SWEEP.some((k: string) => f.startsWith(k)));
    expect(
      fresh,
      `${fresh.length} row(s) have rects that do not sit on the ink. The figure will slide ` +
        `sideways or bob while the creature's world position does not move.\n\n  ` +
        fresh.join("\n  ") +
        `\n\nFix: drop the sidecar's \`cells\` override and let the slicer find ink-tight cells, ` +
        `or re-cut through \`commit.ts\`, which repacks ink-tight by construction. Adding to ` +
        `KNOWN_SWEEP is not the fix — that list is a backlog of art players can already see sliding.`,
    ).toEqual([]);
  }, 600_000);
});
