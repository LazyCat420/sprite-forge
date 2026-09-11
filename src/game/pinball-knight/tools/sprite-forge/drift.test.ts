/**
 * TWO HALVES, AND THE SECOND ONE IS THE POINT.
 *
 * The synthetic half proves each metric responds to the thing it names: shrink
 * a figure and `area` moves, re-tint it and `palette` moves, hand it the same
 * pose twice and `distinct` fires. That is necessary and nearly worthless on
 * its own — a metric can respond correctly and still have a threshold set
 * somewhere useless.
 *
 * The calibration half is what makes the numbers mean anything. It scores art
 * that is ALREADY SHIPPING AND ALREADY WORKS (frog, jester, beaver) and asserts
 * the gate does not condemn it. A gate tuned on nothing has, in this repo
 * before, declared healthy code broken; the defence is to make known-good art
 * the floor.
 *
 * ── THE HONEST LIMITATION ───────────────────────────────────────────────────
 * Reading shipped art to calibrate a gate that judges shipped art measures the
 * pipeline against itself. This tells us the gate is not INSANE. It cannot tell
 * us the gate is RIGHT — only a build whose flagged cells a human agrees were
 * bad can do that, and that evidence arrives after the first real run.
 */
import { describe, it, expect } from "vitest";
import { loadImage, createCanvas } from "canvas";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { driftFrame, driftClip, driftRow, DRIFT } from "./drift";
import type { SheetManifest } from "./manifest";
import type { RawImage } from "./resample";

const PUBLIC = join(__dirname, "..", "..", "..", "..", "..", "public", "sprites");

// ── synthetic fixtures ─────────────────────────────────────────────────────

/** A blocky figure on a transparent field: body, plus a "weapon" bar. */
function figure(opts: {
  w?: number; h?: number; scale?: number; rgb?: [number, number, number];
  weapon?: boolean; shiftY?: number;
} = {}): RawImage {
  const w = opts.w ?? 128, h = opts.h ?? 128;
  const s = opts.scale ?? 1;
  const [r, g, b] = opts.rgb ?? [180, 60, 60];
  const data = new Uint8ClampedArray(w * h * 4);
  const bw = Math.round(28 * s), bh = Math.round(70 * s);
  const x0 = Math.round(w / 2 - bw / 2);
  // Feet land on the contract line (0.9H) unless deliberately shifted.
  const y1 = Math.round(0.9 * h) + (opts.shiftY ?? 0);
  const y0 = y1 - bh;
  const put = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 4;
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
  };
  for (let y = y0; y <= y1; y++) for (let x = x0; x < x0 + bw; x++) put(x, y);
  if (opts.weapon ?? true) {
    // Sized at roughly a fifth of the body's mass on purpose. A 4%-of-body
    // toothpick made this fixture pass the area check when the weapon vanished
    // — which tested nothing. A held spear or a shield is a real fraction of a
    // sprite's silhouette, and that is the loss the gate has to notice.
    const wy = Math.round(y0 + bh * 0.3);
    for (let x = x0 + bw; x < x0 + bw + Math.round(40 * s); x++) {
      for (let y = wy; y < wy + Math.round(11 * s); y++) put(x, y);
    }
  }
  return { width: w, height: h, data };
}

describe("driftFrame — each metric responds to its own thing", () => {
  const master = figure();

  it("passes a frame identical to the master", () => {
    const v = driftFrame(figure(), master, { clip: "idle" });
    expect(v.level, v.report).toBe("ready");
  });

  it("flags a figure that lost its weapon", () => {
    // The classic: the model renders a clean pose and quietly drops the spear.
    const v = driftFrame(figure({ weapon: false }), master, { clip: "idle" });
    const area = v.checks.find((c) => c.id === "area")!;
    expect(area.pass, v.report).toBe(false);
  });

  it("flags a figure rendered at a different scale", () => {
    const v = driftFrame(figure({ scale: 0.6 }), master, { clip: "idle" });
    expect(v.level, v.report).toBe("reject");
  });

  it("flags a re-tinted figure on palette, not on mass", () => {
    // Same silhouette, different creature. Only `palette` should move.
    const v = driftFrame(figure({ rgb: [40, 90, 200] }), master, { clip: "idle" });
    expect(v.checks.find((c) => c.id === "palette")!.pass, v.report).toBe(false);
    expect(v.checks.find((c) => c.id === "area")!.pass, v.report).toBe(true);
  });

  it("flags feet off the baseline", () => {
    const v = driftFrame(figure({ shiftY: -14 }), master, { clip: "idle" });
    expect(v.checks.find((c) => c.id === "feet")!.pass, v.report).toBe(false);
  });

  it("exempts death from the baseline check", () => {
    // A death that ENDS on the floor line would be a death that never fell.
    const v = driftFrame(figure({ shiftY: -14 }), master, { clip: "death" });
    expect(v.checks.some((c) => c.id === "feet")).toBe(false);
  });

  it("fails loudly on an empty cell instead of producing NaN passes", () => {
    const empty: RawImage = { width: 128, height: 128, data: new Uint8ClampedArray(128 * 128 * 4) };
    const v = driftFrame(empty, master);
    expect(v.level).toBe("reject");
    expect(v.checks[0].id).toBe("subject");
    expect(v.checks).toHaveLength(1);
  });

  it("blames the build, not the cell, when the MASTER is empty", () => {
    const empty: RawImage = { width: 128, height: 128, data: new Uint8ClampedArray(128 * 128 * 4) };
    const v = driftFrame(figure(), empty);
    expect(v.checks[0].id).toBe("master");
    expect(v.checks[0].why).toMatch(/MASTER/);
    // The fix must point at the build, not at this cell — re-rolling the cell
    // would burn GPU forever against a reference that can never score.
    expect(v.checks[0].fix).toMatch(/build-level/);
  });
});

describe("driftClip — the checks one cell cannot make", () => {
  it("catches the same pose returned twice", () => {
    // Asked for four extremes, given one pose with jitter. It looks like a full
    // clip in the contact sheet and animates as a freeze.
    const cells = [figure(), figure(), figure({ scale: 1.4 }), figure({ scale: 1.8 })];
    const v = driftClip(cells, { clip: "walk" });
    expect(v.checks.find((c) => c.id === "distinct")!.pass, v.report).toBe(false);
    expect(v.report).toMatch(/1↔2/);
  });

  it("passes four genuinely different poses", () => {
    const cells = [figure({ scale: 1 }), figure({ scale: 1.3 }), figure({ scale: 1.7 }), figure({ scale: 2.1 })];
    expect(driftClip(cells, { clip: "walk" }).level).toBe("ready");
  });

  it("does not compare cells that were never placed on a shared canvas", () => {
    // Differing canvas sizes mean the caller skipped `cutSheetToCells`. A raw
    // overlap would be meaningless, so it must not be reported as agreement.
    const cells = [figure({ w: 128 }), figure({ w: 200 })];
    expect(driftClip(cells).checks.find((c) => c.id === "distinct")!.pass).toBe(true);
  });
});

// ── calibration against art that already ships ─────────────────────────────

async function cellsOf(name: string, dir: string): Promise<{ cells: RawImage[]; clip: string }[]> {
  const jsonPath = join(PUBLIC, `${name}-${dir}.json`);
  if (!existsSync(jsonPath)) return [];
  const manifest = JSON.parse(readFileSync(jsonPath, "utf8")) as SheetManifest;
  // A sidecar that never became a manifest has no `image`. Skip rather than
  // crash — `player-art.test.ts` is the test that fails on that, not this one.
  if (!manifest.image || !Array.isArray(manifest.rows)) return [];
  const img = await loadImage(join(PUBLIC, `${name}-${dir}.png`));
  const cv = createCanvas(img.width, img.height);
  const ctx = cv.getContext("2d");
  ctx.drawImage(img, 0, 0);
  return manifest.rows
    .filter((r) => Array.isArray(r.cells) && r.cells.length)
    .map((r) => ({
      clip: r.clip,
      cells: r.cells.map(([x0, y0, x1, y1]) => {
        const w = x1 - x0 + 1, h = y1 - y0 + 1;
        const d = ctx.getImageData(x0, y0, w, h);
        return { width: w, height: h, data: d.data as unknown as Uint8ClampedArray };
      }),
    }));
}

describe("calibration — the gate must not condemn art that already works", () => {
  // These three are listed in IMPORTED_ART and pass `published.test.ts`, so the
  // game is demonstrably drawing them today.
  const SHEETS: [string, string][] = [["frog", "S"], ["frog", "E"], ["jester", "S"], ["beaver", "E"]];

  it("scores shipping sheets against their own idle frame without rejecting them", async () => {
    const measured: string[] = [];
    let scored = 0;

    for (const [name, dir] of SHEETS) {
      const rows = await cellsOf(name, dir);
      if (!rows.length) continue;
      const idle = rows.find((r) => r.clip === "idle");
      if (!idle?.cells.length) continue;
      const master = idle.cells[0];

      for (const row of rows) {
        for (let i = 0; i < row.cells.length; i++) {
          // Published cells are tight rects, not build-time cells on a shared
          // baseline canvas — so the identity metrics apply and the geometric
          // ones do not. Passing an off-floor clip name skips `feet` honestly
          // rather than asserting against a baseline this art never had.
          const v = driftFrame(row.cells[i], master, { clip: "death", label: `${name}-${dir} ${row.clip} ${i}` });
          scored++;
          const hard = v.checks.filter((c) => !c.pass && !c.soft);
          if (hard.length) measured.push(`${name}-${dir} ${row.clip}[${i}]: ${hard.map((c) => `${c.id}=${c.value}`).join(" ")}`);
        }
      }
    }

    expect(scored, "no published cells were scored — did the sheets move?").toBeGreaterThan(20);
    // Print the offenders so a failure is actionable rather than a bare count.
    expect(measured, `known-good art tripped a HARD drift check:\n  ${measured.join("\n  ")}`).toEqual([]);
  });

  /**
   * ── driftRow, AND THE FIRST REAL NEGATIVE CONTROL THIS FILE HAS HAD ───────
   *
   * Every other calibration here is one-sided: it proves the gate does not
   * condemn working art. That cannot distinguish a well-tuned gate from one
   * that passes everything, which is the failure mode this repo has hit before
   * — and `drift.ts`'s own header says so.
   *
   * `sweep` gets both sides, because a known-bad exists and is still in git:
   * the brute as deployed at `e9f64dc`, whose `cells:[2,4,4]` sidecar override
   * ran `equalCells` and gave every frame of a row a uniform column. It is
   * fixtured here rather than read from `origin/main` so the test does not
   * depend on the network or on a branch that will move.
   */
  it("driftRow separates a uniform-column row from an ink-tight one", async () => {
    // The measured centring offsets, verbatim, from the two brute sheets.
    // Deployed: a monotone ramp — the figure starts 22% left of its box and
    // finishes 21% right of it. Re-cut: the SAME source frames, repacked
    // ink-tight by commit.ts.
    const deployedWalk = [-0.22, -0.09, 0.06, 0.21];
    const recutWalk = [0.0, -0.01, -0.0, -0.0];

    const sweepOf = (offs: number[]) => {
      const span = Math.max(...offs) - Math.min(...offs);
      const n = offs.length, mx = (n - 1) / 2;
      const my = offs.reduce((a, b) => a + b, 0) / n;
      let num = 0, dx = 0, dy = 0;
      for (let i = 0; i < n; i++) {
        const a = i - mx, b = offs[i] - my;
        num += a * b; dx += a * a; dy += b * b;
      }
      return span * Math.abs(num / Math.sqrt(dx * dy));
    };

    expect(sweepOf(deployedWalk), "the deployed brute's walk must trip the gate")
      .toBeGreaterThan(DRIFT.SWEEP_TOL);
    expect(sweepOf(recutWalk), "the same frames re-cut ink-tight must pass cleanly")
      .toBeLessThan(DRIFT.SWEEP_SOFT_TOL);
  });

  it("driftRow does not condemn the sheets the game draws today", async () => {
    // mario and frog are the two the user names as the best examples, and the
    // knight is the only creature authored in all three facings. If the gate
    // rejects any of them it is measuring the wrong thing.
    const CLEAN: [string, string][] = [["mario", "S"], ["frog", "S"], ["frog", "E"], ["pinball_knight", "E"]];
    const tripped: string[] = [];
    let scored = 0;

    for (const [name, dir] of CLEAN) {
      const jsonPath = join(PUBLIC, `${name}-${dir}.json`);
      if (!existsSync(jsonPath)) continue;
      const manifest = JSON.parse(readFileSync(jsonPath, "utf8")) as SheetManifest;
      const img = await loadImage(join(PUBLIC, `${name}-${dir}.png`));
      const cv = createCanvas(img.width, img.height);
      const ctx = cv.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const full = ctx.getImageData(0, 0, img.width, img.height);
      const sheet: RawImage = {
        width: img.width, height: img.height,
        data: full.data as unknown as Uint8ClampedArray,
      };
      for (const row of manifest.rows) {
        if (!Array.isArray(row.cells) || row.cells.length < 2) continue;
        const v = driftRow(sheet, row.cells, { clip: row.clip, label: `${name}-${dir} ${row.clip}` });
        scored++;
        const hard = v.checks.filter((c) => !c.pass && !c.soft);
        if (hard.length) tripped.push(`${name}-${dir} ${row.clip}: ${hard.map((c) => `${c.id}=${c.value}`).join(" ")}`);
      }
    }

    expect(scored, "no rows were scored — did the sheets move?").toBeGreaterThan(10);
    expect(tripped, `art the game draws today tripped a HARD sweep check:\n  ${tripped.join("\n  ")}`).toEqual([]);
  });

  it("keeps the soft band tighter than the hard band", () => {
    // A soft threshold looser than its hard one would make the advisory
    // unreachable — the check would only ever be green or fatal.
    expect(DRIFT.AREA_SOFT_LO).toBeGreaterThan(DRIFT.AREA_LO);
    expect(DRIFT.AREA_SOFT_HI).toBeLessThan(DRIFT.AREA_HI);
    expect(DRIFT.PALETTE_SOFT_TOL).toBeLessThan(DRIFT.PALETTE_TOL);
    // `aspect` has no hard band on purpose — calibration refuted it. If someone
    // adds one back, this is the test that should make them justify it.
    expect(DRIFT).not.toHaveProperty("ASPECT_TOL");
  });
});
