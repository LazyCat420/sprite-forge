/**
 * GHOST — a limb that went semi-transparent instead of moving.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 *
 * Some frames of a Wan clip come back with a leg rendered as a pale, flat,
 * see-through smear. Played back they read as the creature morphing rather than
 * walking, and they are the reason a 21-frame clip gets hand-curated down to
 * "the ones that aren't blurry". Curation by eye does not survive an unattended
 * 18-job build, so this file makes it a number.
 *
 * ── IT IS NOT MOTION BLUR, AND THAT MATTERS ─────────────────────────────────
 *
 * `motion blur` has been in the Wan negative prompt since `graphs.mjs:521` and
 * these frames arrive anyway, because the artefact is made AFTER the sampler.
 * `VAEDecodeTiled` walks the clip in overlapping temporal windows and
 * cross-fades them; where a limb moves fast the two decodes disagree and the
 * blend is a double exposure. Measured on the dog walk of 2026-08-07
 * (`work/comfy/animate-walk-2026-08-07T20-46-28`, temporal_size 8 / overlap 4),
 * the flagged frames are 4, 8, 12, 13, 16 — the window boundaries, and nothing
 * away from a boundary. Frame 16 shows two complete leg positions at half
 * strength each, which a smear cannot do.
 *
 * That is why this is a GATE and not a prompt change. See
 * `docs/PLAN_DOG_WALK.md` §1 for the full measurement and the A/B that settles
 * whether raising `temporal_size` removes it at the source.
 *
 * ── WHAT IS MEASURED ────────────────────────────────────────────────────────
 *
 * Two terms, both required, both RELATIVE to the frame so that the numbers do
 * not encode "a black dog on a white field":
 *
 *   washed   the pixel sits less than half as far from the field colour as the
 *            typical figure pixel does — it is a blend TOWARD the background
 *   flat     local |Laplacian| under a floor — the detail has cancelled out,
 *            which is what averaging two decodes of a moving limb does
 *
 * Either alone is useless. Flat alone fires on every large area of flat colour,
 * which is what pixel art IS. Washed alone fires on any legitimately pale part
 * of a creature. The conjunction is specific to a dissolved limb.
 *
 * The field colour comes from the border median, so a magenta key scores the
 * same way a white one does with no configuration.
 *
 * ── CALIBRATION ─────────────────────────────────────────────────────────────
 *
 * POSITIVE, dog walk 2026-08-07, 21 frames at 640² (the clip this was written
 * for; the flagged indices were picked out by eye first, independently):
 *
 *     clean frames   0.11 – 0.83 %
 *     frames 5, 14   1.70 – 1.84 %   <- the honest grey zone, hence SOFT_TOL
 *     flagged        2.94 – 10.43 %
 *
 * NEGATIVE, the brute idle clip of the same day, same model, same resolution,
 * no ghosting visible: median 0.76 %, MAX 1.25 %, nothing flagged. Its score
 * does rise slightly at 4-6 and 8-10 — the same seams, far weaker because an
 * idle moves less between them, which is a third confirmation of the mechanism.
 *
 * NEGATIVE, every published sheet (brute, frog, jester, beaver, mario, knight,
 * zombie): 0.00 %. This gate cannot condemn shipped art.
 *
 * ⚠️ That last row is also a WARNING, not a boast. Post-matte pixel art scores
 * a structural zero because its alpha is hard — the metric is nearly inert in
 * that domain, and a check that cannot fire is not a check. The positive
 * control for the matted path was built by soft-keying two of the dog frames:
 * the ghost frame scored 3.58 % against the clean frame's 1.67 %, a 2.1×
 * separation where the raw domain gives 95×. The soft key's own fur fringe is
 * the confound.
 *
 * **So this belongs on the RAW generation, before the matte.** The matted path
 * is implemented, reports itself as advisory, and must not be treated as the
 * guard. `a-check-that-passes-for-both-states-is-not-a-check`.
 *
 * Pure: no node imports, no canvas — same contract as `drift.ts`.
 */

import type { QaCheck, QaLevel, QaVerdict } from "./intake-qa";
import type { RawImage } from "./resample";

export const GHOST = {
  /**
   * |Laplacian| on 0-1 luminance below which a pixel has no local detail.
   *
   * Set from the raw-domain histogram: fur, teeth and eye highlights on these
   * frames all sit an order of magnitude above it, and the dissolved legs sit
   * below. It is deliberately not tighter — a tighter floor would start
   * excluding the interior of a genuinely flat fill, which is the half of the
   * conjunction that keeps this from firing on pixel art.
   */
  FLAT: 0.02,
  /**
   * Fraction of the MEDIAN figure distance-from-field under which a pixel
   * counts as washed. Relative on purpose: a pale creature's whole body would
   * fail any absolute threshold, and a magenta field moves the absolute anyway.
   */
  WASHED: 0.5,
  /** Distance from the field colour, 0-255, at which a pixel counts as ink. */
  FIELD_TOL: 24,
  /**
   * Share of the figure that must be washed-and-flat before the frame is
   * rejected. The grey zone between SOFT and hard is real (two frames of the
   * calibration clip live in it) and is reported rather than rounded away.
   */
  TOL: 0.025,
  SOFT_TOL: 0.015,
  /**
   * A frame this far above its own clip's median (in MADs) is an outlier even
   * if it is under TOL. Both rules apply: the absolute one catches a clip that
   * is UNIFORMLY ghosted and therefore has no outliers, and the relative one
   * catches a mild case in an otherwise clean clip. Fail-closed needs both —
   * `a-check-that-passes-for-both-states-is-not-a-check`.
   */
  MADS: 3,
  /**
   * NOTHING fires below this, however big an outlier it is.
   *
   * ── WHY THIS EXISTS, AND WHAT IT COST TO FIND ────────────────────────────
   *
   * The A/B that confirmed the decode fix (2026-08-07: temporal_size 8 → 24 on
   * the same seed and master) came back with EVERY frame between 0.09% and
   * 0.23% — a clip with no ghosting anywhere. The MAD of a series that flat is
   * ~0.01%, so `median + 3*MAD` landed at 0.14%, and the relative rule
   * cheerfully flagged the three frames at 0.16-0.23% as suspicious.
   *
   * That is a gate reporting a defect in art that is measurably perfect,
   * because an outlier test on a clean population finds noise and calls it
   * signal. `a-differently-shaped-probe-condemns-working-code`. The relative
   * rule is still worth having — it catches a mild ghost in an otherwise clean
   * clip — but it must not speak below the level where the defect is visible
   * at all.
   *
   * Set well under SOFT_TOL so the two rules do not collapse into one, and
   * above the 0.23% ceiling the clean A/B run established.
   */
  FLOOR: 0.01,
} as const;

const pct = (n: number) => `${(n * 100).toFixed(2)}%`;

/** Median of a numeric array. Copies, because callers reuse their arrays. */
function median(xs: readonly number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Median absolute deviation — the outlier measure that a ghost cannot skew. */
function mad(xs: readonly number[], med: number): number {
  return median(xs.map((x) => Math.abs(x - med)));
}

/**
 * The background colour, taken as the per-channel median of the 1px border.
 *
 * The border is the one region guaranteed not to be the creature — every mode
 * in this forge asks for a centred figure on a plain field, and `intake-qa`
 * already rejects anything that touches the frame edge. A median rather than a
 * mean so that a creature which does clip a corner cannot drag it.
 */
function fieldColour(img: RawImage): [number, number, number] {
  const { width: w, height: h, data } = img;
  const r: number[] = [], g: number[] = [], b: number[] = [];
  const take = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    r.push(data[i]); g.push(data[i + 1]); b.push(data[i + 2]);
  };
  for (let x = 0; x < w; x++) { take(x, 0); take(x, h - 1); }
  for (let y = 0; y < h; y++) { take(0, y); take(w - 1, y); }
  return [median(r), median(g), median(b)];
}

/**
 * Does this image carry a real matte, or is it a raw opaque generation?
 *
 * "Real" means some pixel is meaningfully transparent. A raw Wan frame is
 * alpha 255 everywhere; a matted cell has a transparent field. The two need
 * different notions of "distance from the field" and the caller should not
 * have to tell us which it handed over.
 */
function hasMatte(img: RawImage): boolean {
  const { data } = img;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 250) return true;
  return false;
}

export interface GhostScore {
  /** Share of the figure that is washed AND flat, 0-1. */
  pct: number;
  /** Share of the whole frame that is figure at all, 0-1. Sanity, not a gate. */
  figure: number;
  /** True when the score came from alpha rather than from a field colour. */
  matted: boolean;
}

/**
 * Score ONE frame. No master and no clip needed — this is a property of the
 * frame, which is why it lives here rather than in `drift.ts`.
 */
export function ghostScore(img: RawImage): GhostScore {
  const { width: w, height: h, data } = img;
  const n = w * h;
  if (n === 0) return { pct: 0, figure: 0, matted: false };

  const matted = hasMatte(img);
  // dist[p] — how far pixel p is from the background, in the units that domain
  // provides: colour distance on a raw frame, alpha on a matted one. A limb
  // that dissolved is close to the field in BOTH readings, which is the whole
  // reason one function can serve both.
  const dist = new Float32Array(n);
  const lum = new Float32Array(n);
  if (matted) {
    for (let p = 0, i = 0; p < n; p++, i += 4) {
      dist[p] = data[i + 3];
      lum[p] = (data[i] + data[i + 1] + data[i + 2]) / (3 * 255);
    }
  } else {
    const [fr, fg, fb] = fieldColour(img);
    for (let p = 0, i = 0; p < n; p++, i += 4) {
      const dr = Math.abs(data[i] - fr), dg = Math.abs(data[i + 1] - fg), db = Math.abs(data[i + 2] - fb);
      dist[p] = Math.max(dr, dg, db);
      lum[p] = (data[i] + data[i + 1] + data[i + 2]) / (3 * 255);
    }
  }

  const inkAt = matted ? 16 : GHOST.FIELD_TOL;
  const figure: number[] = [];
  for (let p = 0; p < n; p++) if (dist[p] > inkAt) figure.push(dist[p]);
  if (!figure.length) return { pct: 0, figure: 0, matted };
  const washedAt = GHOST.WASHED * median(figure);

  // Four-neighbour Laplacian on luminance. The border ring is skipped rather
  // than clamped: a one-pixel frame edge is never the defect and clamping
  // would invent a discontinuity there.
  let soft = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      if (dist[p] <= inkAt || dist[p] >= washedAt) continue;
      const l = Math.abs(4 * lum[p] - lum[p - w] - lum[p + w] - lum[p - 1] - lum[p + 1]);
      if (l < GHOST.FLAT) soft++;
    }
  }
  return { pct: soft / figure.length, figure: figure.length / n, matted };
}

export interface GhostVerdict extends QaVerdict {
  /** Per-frame score, in order. */
  pct: number[];
  /** Indices that failed hard — these are the frames to drop. */
  flagged: number[];
  /** Indices in the grey zone — worth a look before publishing. */
  soft: number[];
}

/**
 * Score a whole clip and name the frames to drop.
 *
 * Returns the `QaVerdict` shape the panel already renders, plus the per-frame
 * numbers, because the numbers are what made this diagnosable in the first
 * place and hiding them behind a boolean would have hidden the mechanism too.
 */
export function ghostClip(
  frames: readonly RawImage[],
  opts: { label?: string } = {},
): GhostVerdict {
  const scores = frames.map(ghostScore);
  const pcts = scores.map((s) => s.pct);
  const med = median(pcts);
  const dev = mad(pcts, med) || 1e-9;
  const cut = med + GHOST.MADS * dev;

  const flagged: number[] = [];
  const softIdx: number[] = [];
  // Both rules are floored: the relative one cannot speak about a frame that is
  // clean in absolute terms, or a flat clean clip reports its own rounding
  // error as a defect. See GHOST.FLOOR.
  const outlier = (v: number) => v > cut && v > GHOST.FLOOR;
  pcts.forEach((v, i) => {
    if (v > GHOST.TOL || (outlier(v) && v > GHOST.SOFT_TOL)) flagged.push(i);
    else if (v > GHOST.SOFT_TOL || outlier(v)) softIdx.push(i);
  });

  const matted = scores.some((s) => s.matted);
  const checks: QaCheck[] = [{
    id: "ghost",
    label: "no dissolved limbs",
    value: flagged.length
      ? `${flagged.length}/${frames.length} over ${pct(GHOST.TOL)} — frames ${flagged.join(", ")} (worst ${pct(Math.max(...pcts))})`
      : `worst ${pct(pcts.length ? Math.max(...pcts) : 0)} of ${frames.length} frames`,
    want: `< ${pct(GHOST.TOL)} washed-and-flat`,
    pass: flagged.length === 0,
    ...(flagged.length ? {
      why: "these frames render a limb as a see-through smear; played back the creature morphs instead of walking",
      fix: "drop them, then fix the source: VAEDecodeTiled cross-fades its temporal windows, so raise temporal_size past the clip length (see docs/PLAN_DOG_WALK.md §1). Re-prompting cannot reach this — `motion blur` is already in the negative.",
    } : {}),
  }];

  if (softIdx.length) {
    checks.push({
      id: "ghost-soft",
      label: "frames near the ghost floor",
      value: `frames ${softIdx.join(", ")}`,
      want: `< ${pct(GHOST.SOFT_TOL)}`,
      pass: false,
      soft: true,
      why: "borderline — the calibration clip had two frames in this band and they were mildly smeared",
      fix: "look at them before publishing; drop if the clip can spare the frames",
    });
  }

  if (matted) {
    checks.push({
      id: "ghost-domain",
      label: "scored pre-matte",
      value: "no — these frames carry alpha",
      want: "raw generation output",
      pass: false,
      soft: true,
      why: "on matted art the separation measured 2.1× against 95× on raw frames — the matte's own soft fringe is the confound, so a pass here is weak evidence",
      fix: "run this on the raw frames the decoder wrote, before the key",
    });
  }

  const failed = checks.filter((c) => !c.pass);
  const level: QaLevel = failed.some((c) => !c.soft) ? "reject" : failed.length ? "usable" : "ready";
  const head = opts.label ? `${opts.label} — ${level.toUpperCase()}` : level.toUpperCase();
  const table = pcts.map((v, i) => {
    const mark = flagged.includes(i) ? " ✗" : softIdx.includes(i) ? " !" : "";
    return `    ${String(i).padStart(3)}  ${pct(v).padStart(7)}${mark}`;
  });
  const lines = checks.map((c) => {
    const m = c.pass ? "  ok " : c.soft ? "  !  " : "  ✗  ";
    const tail = c.pass ? "" : `\n         ${c.why}\n         fix: ${c.fix}`;
    return `${m}${c.label.padEnd(26)} ${c.value}  (want ${c.want})${tail}`;
  });
  return {
    level,
    checks,
    report: [head, ...lines, "", "  ghost% per frame:", ...table].join("\n"),
    pct: pcts,
    flagged,
    soft: softIdx,
  };
}
