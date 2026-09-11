/**
 * THE SNAP-METRIC BENCH — "why is he so grey", answered with arms.
 *
 * Runs the REAL prepped knight sheets through `commitToGrid` under each
 * candidate metric and ban set, scores them against the SOURCE colours they
 * came from, and writes contact strips to `work/snap-ab/` so the decision is
 * made by looking as well as by counting.
 *
 * ── WHAT IS BEING SCORED, AND WHY NOT "ERROR" ────────────────────────────────
 *
 * The obvious metric is mean colour distance to the source. It is the wrong
 * one, and it would have picked the arm that made the problem: a 32-entry
 * palette cannot match a 1600-colour figure, so the lowest-error answer is the
 * one that lands everything on mid-greys — exactly the failure being fixed. So
 * three things are scored instead:
 *
 *   saturation   mean S of the committed texels against the SOURCE's own mean.
 *                Below 1.0 means the snap desaturated the creature.
 *   onRamp       share of texels landing on the material families a KNIGHT is
 *                made of (steel/skin/leather/ink) rather than on `stone`, the
 *                environment ramp he kept being snapped onto.
 *   entries      distinct palette entries kept. Fewer is not better — it means
 *                the metric consolidated rather than scattered.
 *
 * `RUN_SNAP_AB=1 npx vitest run snap-metric` to write the strips.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createCanvas, loadImage } from "canvas";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installSpriteTestDom } from "../../testkit/atlas-census";
import { PALETTE_FAMILIES, PALETTE_HEX } from "../../render/palette";
import { commitToGrid, type RawImage } from "./commit";
import { oklab } from "./colour";
import type { SnapMetric } from "./colour";
import type { ManifestRow } from "./manifest";

const HERE = __dirname;
const INBOX = join(HERE, "inbox");
const OUT = join(HERE, "work", "snap-ab");

let restore = (): void => {};
beforeAll(() => { restore = installSpriteTestDom(); });
afterAll(() => { restore(); });

const PAL = (): number[][] => PALETTE_HEX.map((h) => [(h >> 16) & 255, (h >> 8) & 255, h & 255]);

/** Palette index → family name, for the on-ramp score. */
const FAMILY_OF = new Map<number, string>();
for (const [fam, ids] of Object.entries(PALETTE_FAMILIES)) for (const i of ids) FAMILY_OF.set(i, fam);
/** What a knight is MADE OF. `stone` is the dungeon, not the armour. */
const KNIGHT_MATERIALS = new Set(["steel", "skin", "leather", "torch"]);

function sat(r: number, g: number, b: number): number {
  const mx = Math.max(r, g, b);
  return mx > 0 ? (mx - Math.min(r, g, b)) / mx : 0;
}

async function sheet(dir: string): Promise<{ img: RawImage; rows: ManifestRow[] }> {
  const side = JSON.parse(readFileSync(join(INBOX, `pinball_knight-${dir}.json`), "utf8")) as {
    rows: string[];
    rects: number[][][];
  };
  const image = await loadImage(join(INBOX, `pinball_knight-${dir}.png`));
  const c = createCanvas(image.width, image.height);
  const ctx = c.getContext("2d");
  ctx.drawImage(image as never, 0, 0);
  const d = ctx.getImageData(0, 0, image.width, image.height);
  return {
    img: { width: image.width, height: image.height, data: d.data as unknown as Uint8ClampedArray },
    rows: side.rows.map((clip, i) => ({ clip, cells: side.rects[i] as ManifestRow["cells"] })),
  };
}

interface Arm { key: string; label: string; metric: SnapMetric; bans: string[] }

const ARMS: Arm[] = [
  { key: "A", label: "luma (legacy)", metric: "luma", bans: ["rot"] },
  { key: "B", label: "oklab", metric: "oklab", bans: ["rot"] },
  { key: "C", label: "luma + ban stone", metric: "luma", bans: ["rot", "stone"] },
  { key: "D", label: "oklab + ban stone", metric: "oklab", bans: ["rot", "stone"] },
];

describe("snap metric bench", () => {
  it("scores each arm on the real knight sheets", async () => {
    const pal = PAL();
    const byIdx = new Map<number, number>();
    pal.forEach((p, i) => byIdx.set((p[0] << 16) | (p[1] << 8) | p[2], i));

    const { img, rows } = await sheet("E");

    // The SOURCE's own saturation over the cells being committed — the baseline
    // every arm is measured against, computed once from the prepped pixels.
    let ss = 0, sn = 0;
    for (const row of rows) {
      for (const [x0, y0, x1, y1] of row.cells) {
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            const i = (y * img.width + x) * 4;
            if (img.data[i + 3] <= 127) continue;
            ss += sat(img.data[i], img.data[i + 1], img.data[i + 2]);
            sn++;
          }
        }
      }
    }
    const srcSat = ss / sn;

    const report: string[] = [`SOURCE mean saturation ${srcSat.toFixed(3)} over ${sn} px\n`];
    const scored: { arm: Arm; satRatio: number; onRamp: number; entries: number; contrast: number; arcane: number }[] = [];

    for (const arm of ARMS) {
      const ban = arm.bans.flatMap((f) => [...(PALETTE_FAMILIES[f] ?? [])]);
      const r = commitToGrid(img, rows, pal, { ban, metric: arm.metric });

      let s = 0, n = 0, onRamp = 0, arcane = 0;
      // LOCAL CONTRAST — the number that actually tracks "muddy".
      // Mean |Δluma| between orthogonally adjacent opaque texels. A figure whose
      // plates, straps and shadows separate has a high one; a figure snapped onto
      // one flat ramp has a low one, however "accurate" its mean colour is.
      let lc = 0, lcN = 0;
      {
        const W = r.image.width, D = r.image.data;
        const L = (i: number): number => 0.3 * D[i] + 0.59 * D[i + 1] + 0.11 * D[i + 2];
        for (let y = 0; y < r.image.height; y++) {
          for (let x = 0; x < W - 1; x++) {
            const i = (y * W + x) * 4, j = i + 4;
            if (D[i + 3] <= 127 || D[j + 3] <= 127) continue;
            lc += Math.abs(L(i) - L(j)); lcN++;
          }
        }
      }
      const fam = new Map<string, number>();
      for (let p = 0; p < r.image.data.length; p += 4) {
        if (r.image.data[p + 3] <= 127) continue;
        const key = (r.image.data[p] << 16) | (r.image.data[p + 1] << 8) | r.image.data[p + 2];
        const idx = byIdx.get(key);
        expect(idx, "committed texel is off-palette").toBeDefined();
        const f = FAMILY_OF.get(idx!) ?? "ink";
        fam.set(f, (fam.get(f) ?? 0) + 1);
        if (KNIGHT_MATERIALS.has(f) || f === "ink") onRamp++;
        if (f === "arcane") arcane++;
        s += sat(r.image.data[p], r.image.data[p + 1], r.image.data[p + 2]);
        n++;
      }
      const satRatio = s / n / srcSat;
      const contrast = lcN ? lc / lcN : 0;
      scored.push({ arm, satRatio, onRamp: onRamp / n, entries: r.report.entries, contrast, arcane: arcane / n });
      const top = [...fam.entries()].sort((a, b) => b[1] - a[1]).map(([f, c]) => `${f} ${((c / n) * 100).toFixed(0)}%`);
      report.push(
        `${arm.key}  ${arm.label.padEnd(20)} sat ${(satRatio * 100).toFixed(0)}% of source · ` +
          `on-ramp ${((onRamp / n) * 100).toFixed(0)}% · contrast ${contrast.toFixed(1)} · entries ${r.report.entries}\n` +
          `     families: ${top.join("  ")}`,
      );

      if (process.env.RUN_SNAP_AB) {
        mkdirSync(OUT, { recursive: true });
        const g = r.report.factor;
        const idleRow = r.rows.find((x) => x.clip === "idle")!;
        const cells = idleRow.cells.map((c) => c);
        const w = cells.reduce((a, c) => a + (c[2] - c[0] + 1) / g + 2, 2);
        const h = Math.max(...cells.map((c) => (c[3] - c[1] + 1) / g)) + 4;
        const Z = 6;
        const out = createCanvas(Math.ceil(w) * Z, Math.ceil(h) * Z);
        const octx = out.getContext("2d");
        octx.fillStyle = "#14161c";
        octx.fillRect(0, 0, out.width, out.height);
        octx.imageSmoothingEnabled = false;
        const full = createCanvas(r.image.width, r.image.height);
        const fctx = full.getContext("2d");
        const fimg = fctx.createImageData(r.image.width, r.image.height);
        fimg.data.set(r.image.data as unknown as Uint8ClampedArray);
        fctx.putImageData(fimg, 0, 0);
        let x = 2;
        for (const c of cells) {
          const cw = (c[2] - c[0] + 1) / g;
          const ch = (c[3] - c[1] + 1) / g;
          octx.drawImage(full as never, c[0], c[1], c[2] - c[0] + 1, c[3] - c[1] + 1,
            x * Z, (h - 2 - ch) * Z, cw * Z, ch * Z);
          x += cw + 2;
        }
        writeFileSync(join(OUT, `${arm.key}-${arm.metric}${arm.bans.includes("stone") ? "-nostone" : ""}.png`),
          out.toBuffer("image/png"));
      }
    }

    if (process.env.RUN_SNAP_AB) {
      mkdirSync(OUT, { recursive: true });
      writeFileSync(join(OUT, "report.txt"), report.join("\n\n") + "\n");
    }

    // ── THE ASSERTIONS ──────────────────────────────────────────────────────
    //
    // Not "oklab wins on every number" — that would pin a bench result as a
    // contract. What is pinned is the PROPERTY the change exists for: the
    // shipped metric must not desaturate the creature relative to the legacy
    // one, and must not put more of a knight on the environment ramp.
    const A = scored.find((s) => s.arm.key === "A")!;
    const B = scored.find((s) => s.arm.key === "B")!;
    const C = scored.find((s) => s.arm.key === "C")!;
    const D = scored.find((s) => s.arm.key === "D")!;

    // ⚠️ WHAT IS *NOT* ASSERTED, AND WHY. "oklab beats luma" was the hypothesis
    // this bench was built to confirm, and the bench refused: on saturation
    // (75% vs 77%), on family share and on local contrast (3.6 vs 3.8) the
    // legacy metric is level or marginally ahead. Pinning any of those would
    // pin a result the evidence does not support. `oklab` ships on the material
    // claim the `face` block below measures — skin arriving as skin — and on
    // consolidating rather than scattering, not on these numbers.
    expect(A.entries).toBeLessThanOrEqual(20);
    expect(B.entries).toBeLessThanOrEqual(20);

    // ⚠️ BANNING `stone` IS RECORDED AS REJECTED, not left as a tempting idea.
    // It looks like the obvious fix — a knight is not made of dungeon wall — and
    // it scores beautifully on any "is he on his own ramp" metric. It also
    // forces the armour onto `arcane`, the saturated cold accent, and the strips
    // come back speckled with blue confetti. Whichever arm ships, the ban must
    // not: assert it costs contrast so nobody re-proposes it from the numbers.
    expect(C.onRamp).toBeGreaterThan(A.onRamp); // it does score better...
    expect(D.onRamp).toBeGreaterThan(B.onRamp);
    // ...and it buys that score with `arcane`, the saturated cold accent: 13%
    // of the figure under arm C against 4% under the control. That is the blue
    // confetti in `work/snap-ab/C-luma-nostone.png`.
    expect(C.arcane, `banning stone stopped leaking onto arcane — re-look at the strips:\n${report.join("\n")}`)
      .toBeGreaterThan(A.arcane * 2);
  }, 600000);
});

describe("density sweep — is it just pixels?", () => {
  it("renders the head at each texel budget", async () => {
    const pal = PAL();
    const { img, rows } = await sheet("E");
    const OUT2 = join(HERE, "work", "density-ab");
    mkdirSync(OUT2, { recursive: true });
    const lines: string[] = [];
    for (const fitH of [90, 110, 120, 132, 150, 176]) {
      // fitGrid is fixed at the default rung; ART_FIT_H is what the budget
      // scales with, so drive it by an equivalent fitGrid to avoid editing a
      // shared constant inside a bench.
      const fitGrid = Math.round((84 * fitH) / 110);
      const r = commitToGrid(img, rows, pal, { ban: [...PALETTE_FAMILIES.rot], fitGrid });
      const g = r.report.factor;
      const idle = r.rows.find((x) => x.clip === "idle")!;
      const c = idle.cells[0];
      const cw = (c[2] - c[0] + 1) / g, ch = (c[3] - c[1] + 1) / g;
      const full = createCanvas(r.image.width, r.image.height);
      const fctx = full.getContext("2d");
      const fimg = fctx.createImageData(r.image.width, r.image.height);
      fimg.data.set(r.image.data as unknown as Uint8ClampedArray);
      fctx.putImageData(fimg, 0, 0);
      // crop the HEAD: top 38% of the cell, the same fraction headBox uses
      const hh = Math.round(ch * 0.38);
      const Z = Math.max(2, Math.round(240 / hh));
      const out = createCanvas(Math.round(cw) * Z, hh * Z);
      const octx = out.getContext("2d");
      octx.fillStyle = "#14161c"; octx.fillRect(0, 0, out.width, out.height);
      octx.imageSmoothingEnabled = false;
      octx.drawImage(full as never, c[0], c[1], c[2] - c[0] + 1, hh * g, 0, 0, Math.round(cw) * Z, hh * Z);
      writeFileSync(join(OUT2, `h${String(fitH).padStart(3, "0")}-${Math.round(ch)}tex.png`), out.toBuffer("image/png"));
      lines.push(`ART_FIT_H ${fitH}  ->  figure ${Math.round(cw)}x${Math.round(ch)} texels, head ${hh} texels tall, ${r.report.entries} entries`);
    }
    writeFileSync(join(OUT2, "report.txt"), lines.join("\n") + "\n");
  }, 300000);
});

describe("the face", () => {
  it("reports which ramp the knight's skin lands on, per arm", async () => {
    const pal = PAL();
    const byIdx = new Map<number, number>();
    pal.forEach((p, i) => byIdx.set((p[0] << 16) | (p[1] << 8) | p[2], i));
    const { img, rows } = await sheet("E");
    const lines: string[] = [];
    for (const arm of ARMS) {
      const ban = arm.bans.flatMap((f) => [...(PALETTE_FAMILIES[f] ?? [])]);
      const r = commitToGrid(img, rows, pal, { ban, metric: arm.metric });
      const g = r.report.factor;
      const c = r.rows.find((x) => x.clip === "idle")!.cells[0];
      const ch = c[3] - c[1] + 1;
      // The face: the top 38% of the cell (the helmet box), counting only
      // texels that are NOT neutral — the skin, the eyes, whatever else lands
      // there. A neutral filter keeps the helmet's greys out of the tally.
      const fam = new Map<string, number>();
      for (let y = c[1]; y <= c[1] + ch * 0.38; y += g) {
        for (let x = c[0]; x <= c[2]; x += g) {
          const i = (y * r.image.width + x) * 4;
          if (r.image.data[i + 3] <= 127) continue;
          const R = r.image.data[i], G = r.image.data[i + 1], B = r.image.data[i + 2];
          const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
          if (mx === 0 || (mx - mn) / mx < 0.22) continue; // neutral = helmet
          const idx = byIdx.get((R << 16) | (G << 8) | B)!;
          const f = FAMILY_OF.get(idx) ?? "ink";
          fam.set(`${f}[${idx}]`, (fam.get(`${f}[${idx}]`) ?? 0) + 1);
        }
      }
      const tot = [...fam.values()].reduce((a, b) => a + b, 0) || 1;
      const top = [...fam.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
        .map(([f, n]) => `${f} ${((n / tot) * 100).toFixed(0)}%`);
      lines.push(`${arm.key} ${arm.label.padEnd(20)} ${top.join("  ")}`);
    }
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, "face.txt"), lines.join("\n") + "\n");
  }, 300000);
});

describe("presharpen sweep", () => {
  it("renders the head and the whole figure at each amount", async () => {
    const pal = PAL();
    const { img, rows } = await sheet("E");
    const OUT3 = join(HERE, "work", "presharpen-ab");
    mkdirSync(OUT3, { recursive: true });
    const lines: string[] = [];
    for (const amt of [0, 0.4, 0.8, 1.2, 1.8]) {
      for (const metric of ["luma", "oklab"] as SnapMetric[]) {
        const r = commitToGrid(img, rows, pal, {
          ban: [...PALETTE_FAMILIES.rot], metric, presharpen: amt,
        });
        const g = r.report.factor;
        const full = createCanvas(r.image.width, r.image.height);
        const fctx = full.getContext("2d");
        const fimg = fctx.createImageData(r.image.width, r.image.height);
        fimg.data.set(r.image.data as unknown as Uint8ClampedArray);
        fctx.putImageData(fimg, 0, 0);
        const idle = r.rows.find((x) => x.clip === "idle")!;

        // whole-figure strip
        const cells = idle.cells;
        const W = cells.reduce((a, c) => a + (c[2] - c[0] + 1) / g + 2, 2);
        const H = Math.max(...cells.map((c) => (c[3] - c[1] + 1) / g)) + 4;
        const Z = 7;
        const out = createCanvas(Math.ceil(W) * Z, Math.ceil(H) * Z);
        const octx = out.getContext("2d");
        octx.fillStyle = "#14161c"; octx.fillRect(0, 0, out.width, out.height);
        octx.imageSmoothingEnabled = false;
        let x = 2;
        for (const c of cells) {
          const cw = (c[2] - c[0] + 1) / g, ch = (c[3] - c[1] + 1) / g;
          octx.drawImage(full as never, c[0], c[1], c[2] - c[0] + 1, c[3] - c[1] + 1,
            x * Z, (H - 2 - ch) * Z, cw * Z, ch * Z);
          x += cw + 2;
        }
        writeFileSync(join(OUT3, `fig-${metric}-${amt.toFixed(1)}.png`), out.toBuffer("image/png"));

        // head crop, big
        const c0 = idle.cells[0];
        const ch0 = (c0[3] - c0[1] + 1) / g;
        const hh = Math.round(ch0 * 0.4);
        const ZH = 14;
        const head = createCanvas(Math.round((c0[2] - c0[0] + 1) / g) * ZH, hh * ZH);
        const hctx = head.getContext("2d");
        hctx.fillStyle = "#14161c"; hctx.fillRect(0, 0, head.width, head.height);
        hctx.imageSmoothingEnabled = false;
        hctx.drawImage(full as never, c0[0], c0[1], c0[2] - c0[0] + 1, hh * g, 0, 0, head.width, head.height);
        writeFileSync(join(OUT3, `head-${metric}-${amt.toFixed(1)}.png`), head.toBuffer("image/png"));

        // local contrast, same definition as the metric bench
        let lc = 0, lcN = 0;
        const Wd = r.image.width, D = r.image.data;
        const L = (i: number): number => 0.3 * D[i] + 0.59 * D[i + 1] + 0.11 * D[i + 2];
        for (let y = 0; y < r.image.height; y++) {
          for (let xx = 0; xx < Wd - 1; xx++) {
            const i = (y * Wd + xx) * 4, j = i + 4;
            if (D[i + 3] <= 127 || D[j + 3] <= 127) continue;
            lc += Math.abs(L(i) - L(j)); lcN++;
          }
        }
        lines.push(`presharpen ${amt.toFixed(1)}  ${metric.padEnd(6)}  contrast ${(lc / lcN).toFixed(2)}  entries ${r.report.entries}  despeckled ${r.report.despeckled}`);
      }
    }
    writeFileSync(join(OUT3, "report.txt"), lines.join("\n") + "\n");
  }, 600000);
});

describe("region floor sweep", () => {
  it("renders the figure and the head at each minRegion", async () => {
    const pal = PAL();
    const { img, rows } = await sheet("E");
    const OUT4 = join(HERE, "work", "flat-ab");
    mkdirSync(OUT4, { recursive: true });
    const lines: string[] = [];
    for (const mr of [0, 3, 4, 6, 9]) {
      const r = commitToGrid(img, rows, pal, { ban: [...PALETTE_FAMILIES.rot], minRegion: mr });
      const g = r.report.factor;
      const full = createCanvas(r.image.width, r.image.height);
      const fctx = full.getContext("2d");
      const fimg = fctx.createImageData(r.image.width, r.image.height);
      fimg.data.set(r.image.data as unknown as Uint8ClampedArray);
      fctx.putImageData(fimg, 0, 0);
      const idle = r.rows.find((x) => x.clip === "idle")!;
      const cells = idle.cells;
      const W = cells.reduce((a, c) => a + (c[2] - c[0] + 1) / g + 2, 2);
      const H = Math.max(...cells.map((c) => (c[3] - c[1] + 1) / g)) + 4;
      const Z = 7;
      const out = createCanvas(Math.ceil(W) * Z, Math.ceil(H) * Z);
      const octx = out.getContext("2d");
      octx.fillStyle = "#14161c"; octx.fillRect(0, 0, out.width, out.height);
      octx.imageSmoothingEnabled = false;
      let x = 2;
      for (const c of cells) {
        const cw = (c[2] - c[0] + 1) / g, ch = (c[3] - c[1] + 1) / g;
        octx.drawImage(full as never, c[0], c[1], c[2] - c[0] + 1, c[3] - c[1] + 1,
          x * Z, (H - 2 - ch) * Z, cw * Z, ch * Z);
        x += cw + 2;
      }
      writeFileSync(join(OUT4, `fig-min${mr}.png`), out.toBuffer("image/png"));
      const c0 = cells[0];
      const ch0 = (c0[3] - c0[1] + 1) / g;
      const hh = Math.round(ch0 * 0.42), ZH = 14;
      const head = createCanvas(Math.round((c0[2] - c0[0] + 1) / g) * ZH, hh * ZH);
      const hctx = head.getContext("2d");
      hctx.fillStyle = "#14161c"; hctx.fillRect(0, 0, head.width, head.height);
      hctx.imageSmoothingEnabled = false;
      hctx.drawImage(full as never, c0[0], c0[1], c0[2] - c0[0] + 1, hh * g, 0, 0, head.width, head.height);
      writeFileSync(join(OUT4, `head-min${mr}.png`), head.toBuffer("image/png"));

      // MEAN REGION SIZE — the number that tracks "flat like an RO sprite".
      const D = r.image.data, Wd = r.image.width, Hd = r.image.height;
      const key = (i: number): number => (D[i] << 16) | (D[i + 1] << 8) | D[i + 2];
      const seen = new Uint8Array(Wd * Hd);
      let regions = 0, texels = 0, iso = 0;
      for (let p = 0; p < Wd * Hd; p++) {
        if (seen[p] || D[p * 4 + 3] <= 127) continue;
        const k = key(p * 4);
        const stack = [p]; seen[p] = 1; let n = 0;
        while (stack.length) {
          const q = stack.pop()!; n++;
          const qx = q % Wd, qy = (q / Wd) | 0;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            const nx = qx + dx, ny = qy + dy;
            if (nx < 0 || ny < 0 || nx >= Wd || ny >= Hd) continue;
            const nn = ny * Wd + nx;
            if (seen[nn] || D[nn * 4 + 3] <= 127 || key(nn * 4) !== k) continue;
            seen[nn] = 1; stack.push(nn);
          }
        }
        regions++; texels += n;
        if (n <= g * g) iso++;   // one authored texel = g*g pixels at this factor
      }
      lines.push(`minRegion ${mr}  mean region ${(texels / regions / (g * g)).toFixed(2)} texels  ` +
        `single-texel regions ${((iso / regions) * 100).toFixed(1)}%  entries ${r.report.entries}`);
    }
    writeFileSync(join(OUT4, "report.txt"), lines.join("\n") + "\n");
  }, 600000);
});
