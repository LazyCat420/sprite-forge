/**
 * MOTION — did the clip move at all?
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 *
 * Wan returns 21 beautifully rendered frames of a creature doing nothing. Every
 * frame is clean, the identity is perfect, the field is keyable, and played
 * back at 8fps it is a still photograph. It has happened twice:
 *
 *   2026-08-07  the first dog idle — 479×588 for all 21 frames
 *   2026-08-08  `idle4 --loop` — churn median 0.2%, 2 distinct bounding boxes
 *
 * Both got all the way to a human before anything noticed, because **no
 * automated gate in this pipeline can see it**. `ghost.ts` scores frames for
 * dissolved limbs and a frozen clip has none — the 08-08 idle scored 0.09%
 * against a 1% floor and reported `level: "ready"`. A gate passing is not the
 * same as a clip being good, and here the gate was passing *because* the clip
 * was dead.
 *
 * ── WHY THIS IS NOT `drift.ts` ──────────────────────────────────────────────
 *
 * `driftClip` already has a duplicate-pose check (IoU over the alpha mask) that
 * would catch this. It runs on REGISTERED CELLS — after matte, after slice,
 * after `registerCell`. By then the operator has cut the clip, filed it and
 * spent the review. This file runs on the RAW frames inside the generating run,
 * next to `ghostClip`, which is the only place the failure is still free to
 * fix: the answer to a frozen clip is always "generate it again", never
 * "curate it better" (`10-dead-ends.md`, and commit `7035534` where picking
 * "the two least-identical frames" out of a dead generation was tried).
 *
 * It also sees what an IoU over the silhouette cannot: a creature that breathes
 * without changing outline moves plenty of interior pixels and almost no edge.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ──────────────────────────────────────
 *
 * It does not grade how GOOD the motion is. That metric was built, and on
 * 2026-08-08 it scored `walk4 + --loop` at 37% against a bare free-run's 36%
 * and was one commit from retiring the lever that actually works — the operator
 * looked at the two side by side and the walk4 arm was obviously better. A gait
 * reads because the RIGHT pixels change in the RIGHT order, and pixel churn
 * cannot see order. See `10-dead-ends.md`, "NOT a dead end".
 *
 * So the only question asked here is the one with an unambiguous answer:
 * **did anything happen?** A freeze is a failed generation by the pipeline's own
 * standing rule. Everything above a freeze goes to the eye, which is the gate.
 *
 * ── CALIBRATION ─────────────────────────────────────────────────────────────
 *
 * POSITIVE (real motion), dog walk `sources/dog-2026-08-07`, the one approved
 * clip this pipeline has produced:
 *
 *     churn median 23.7 %   min 3.4 %   max 35.4 %   18 of 21 distinct boxes
 *
 * NEGATIVE (frozen), `work/comfy/animate-idle4-2026-08-08T19-49-56`:
 *
 *     churn median  0.2 %   min 0.1 %   max  1.5 %    2 of 21 distinct boxes
 *
 * Two orders of magnitude apart, so `FROZEN` sits at 2 % — above the dead
 * clip's MAXIMUM frame and more than ten times below the good clip's median.
 *
 * ⚠️ THE POSITIVE SIDE IS n=1. That is why the threshold is set to catch a
 * corpse rather than to judge a performance: one approved clip is enough to say
 * "0.2 % is dead", and nowhere near enough to say what a good number is. Do not
 * raise `FROZEN` toward the positive without more approved clips behind it —
 * and if you find yourself wanting to, you are rebuilding the quality metric
 * this file's header says not to.
 *
 * ── ⚠️ THE SEPARATION IS MUCH NARROWER THAN 23.7 vs 0.2 SUGGESTS ────────────
 *
 * The same day, `idle4` WITHOUT `--loop` came back genuinely alive — tail
 * swinging, head shifting, paws planted, judged by eye — and measured:
 *
 *     churn median 2.08 %   12 of 21 distinct boxes   loop seam 12.6 %
 *
 * It cleared this floor by EIGHT HUNDREDTHS OF A POINT.
 *
 * So the honest statement of what this gate can do:
 *
 *     dead vs a GAIT      23.7 % vs 0.2 %   — 100x, unmissable
 *     dead vs a SUBTLE    2.08 % vs 0.2 %   — 1.4x, and the live one sits
 *       clip                                  0.08 points over the line
 *
 * An idle moves a little BY DEFINITION, and this measure cannot cleanly tell
 * "a little" from "not at all". Against a walk or a run it is decisive; against
 * an idle it is a coin flip that happened to land right. Treat a near-floor
 * PASS on a subtle clip as "look at it", never as "it is fine" — and treat a
 * near-floor FAIL the same way rather than binning the frames, which is why
 * this gate warns and records instead of throwing.
 *
 * Fixing this properly needs a measure that is not pixel churn — the churn
 * decayed monotonically across that clip (5.78 % → 0.98 %) while the creature
 * was visibly moving throughout, which is the tell that the quantity and the
 * phenomenon are only loosely related.
 */
import type { QaCheck, QaLevel, QaVerdict } from "./intake-qa";
import type { RawImage } from "./resample";

const pct = (n: number) => `${(n * 100).toFixed(2)}%`;

export const MOTION = {
  /** A pixel counts as changed when any channel moves more than this. */
  DELTA: 12,
  /** Ink threshold against the field colour, for finding the figure. */
  FIELD_TOL: 28,
  /** Below this median churn the clip is a still photograph. */
  FROZEN: 0.02,
  /**
   * A clip whose bounding box never changes is suspect even above the churn
   * floor — it is the shape of "the model re-rendered the same pose with
   * different noise". Both recorded freezes had ≤2 distinct boxes out of
   * 12-21; the approved walk had 18 of 21. Reported as SOFT, never hard: a
   * legitimate breathing idle really can hold one silhouette.
   */
  BOXES_SOFT: 0.25,
  /**
   * ── THE FOURTH AXIS: THE FIGURE CHANGED SIZE ──────────────────────────────
   *
   * How much the figure's BOX AREA may swing across a clip, as a fraction of
   * the largest frame. Measured on three attack arms, same init, seed 7, one
   * prompt variable each:
   *
   *     arm            churn   boxes   seam    AREA SWING
   *     1 original     11.1%   20/21   45.1%      7.3%    stable, but inert
   *     2 freed pose   28.3%   21/21   61.1%     43.9%    shrinks
   *     3 + size pin   27.1%   21/21   63.6%     62.3%    shrinks MORE
   *
   * Every gate this pipeline had passed all three. `motion` saw arms 2 and 3
   * as a big improvement — churn 2.5x, a perfect 21/21 silhouettes — because
   * churn cannot tell a lunge from a ZOOM-OUT: a receding figure changes an
   * enormous number of pixels. `ghost` was clean, `fade` was advisory.
   *
   * It matters more than it looks. Downstream, `drift.ts` registers cells by
   * bounding box and baseline, so a figure that halves across a clip is not a
   * pose it can register — it is a different sprite. This is the one defect on
   * the list that nothing later can repair.
   *
   * 25% is set between the arms: five times the good arm's 7.3% and well under
   * the 43.9% of the first bad one. SOFT, because a legitimate death collapse
   * genuinely shrinks its own box, and the point is to make the operator look.
   */
  SCALE_SWING_SOFT: 0.25,
  /**
   * ── SWING WAS THE WRONG QUANTITY. THE TREND IS THE RIGHT ONE. ─────────────
   *
   * The swing threshold above flagged the first real clip it met — N:run, a
   * gallop — and it was a FALSE POSITIVE. A galloping body extends and gathers,
   * so its box area genuinely swings; from behind, that extension runs along
   * the view axis and swings hard. The difference from a receding figure is not
   * the magnitude, it is the SHAPE: a gait comes back, a recession does not.
   *
   * Three labelled clips, area per frame as a fraction of the clip mean:
   *
   *   N:run        1.16 1.14 1.04 0.86 0.82 0.78 0.95 ... 1.12 1.17 1.16
   *                swing 33.1%   trend +0.42%/frame   <- GAIT, returns to size
   *   attack arm3  1.29 1.28 1.27 ... 0.71 0.63 0.50 0.48
   *                swing 62.3%   trend -4.11%/frame   <- RECESSION, monotonic
   *   S:walk       1.04 1.03 1.00 ... 0.98 1.00 1.01 1.04
   *                swing  7.3%   trend -0.03%/frame   <- stable
   *
   * Least-squares slope over the clip, as a percent of mean area per frame,
   * separates them with a wide margin where swing does not. -1.5%/frame sits
   * between the gallop's +0.42 and the recession's -4.11.
   *
   * A count of oscillations was tried first and is NOT a discriminator: all
   * three clips register 6-7 sign changes, because a monotonic decline still
   * jitters. That check returned the same answer for a gait and a recession,
   * which is the definition of not being a check.
   *
   * Still SOFT. A death collapse shrinks monotonically and is supposed to.
   */
  SCALE_TREND_SOFT: 0.015,
} as const;

/** Border-median field colour, the same trick `ghost.ts` uses to stay key-agnostic. */
function fieldColour(img: RawImage): [number, number, number] {
  const { width: w, height: h, data } = img;
  const out: [number[], number[], number[]] = [[], [], []];
  const sample = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    out[0].push(data[i]); out[1].push(data[i + 1]); out[2].push(data[i + 2]);
  };
  for (let x = 0; x < w; x++) { sample(x, 0); sample(x, h - 1); }
  for (let y = 0; y < h; y++) { sample(0, y); sample(w - 1, y); }
  return out.map((c) => c.sort((a, b) => a - b)[c.length >> 1]) as [number, number, number];
}

/** Tight box around the ink, as [x0, y0, x1, y1]; a blank frame gives a zero box. */
export function figureBox(img: RawImage): [number, number, number, number] {
  const { width: w, height: h, data } = img;
  const matted = (() => { for (let i = 3; i < data.length; i += 4) if (data[i] < 250) return true; return false; })();
  const [fr, fg, fb] = matted ? [0, 0, 0] : fieldColour(img);
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const ink = matted
        ? data[i + 3] > 16
        : Math.max(Math.abs(data[i] - fr), Math.abs(data[i + 1] - fg), Math.abs(data[i + 2] - fb)) > MOTION.FIELD_TOL;
      if (!ink) continue;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? [0, 0, 0, 0] : [x0, y0, x1, y1];
}

/**
 * Share of pixels that changed between two frames, measured INSIDE the given
 * box.
 *
 * The box matters: over a whole 640² canvas a moving dog is a few percent of
 * the pixels and every clip scores "barely moved", which is how a churn number
 * gets dismissed as noise. Restricting to the figure is what makes 0.2 % and
 * 23.7 % different in kind rather than in rounding.
 */
export function churn(a: RawImage, b: RawImage, box: [number, number, number, number]): number {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`[motion] frames differ in size (${a.width}×${a.height} vs ${b.width}×${b.height}) — this is a cut sheet, not a clip`);
  }
  const [x0, y0, x1, y1] = box;
  let changed = 0, total = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * a.width + x) * 4;
      const d = Math.max(
        Math.abs(a.data[i] - b.data[i]),
        Math.abs(a.data[i + 1] - b.data[i + 1]),
        Math.abs(a.data[i + 2] - b.data[i + 2]),
      );
      if (d > MOTION.DELTA) changed++;
      total++;
    }
  }
  return total ? changed / total : 0;
}

export interface MotionVerdict extends QaVerdict {
  /** Frame-to-frame churn, in order; `churn[i]` is frame i → i+1. */
  churn: number[];
  /** Churn from the last frame back to the first — how well the cycle closes. */
  seam: number;
  /** Distinct figure bounding boxes across the clip. */
  boxes: number;
  /**
   * Largest-to-smallest swing in the figure's box AREA, 0-1. The axis every
   * other gate is blind to — churn actively rewards it, because a receding
   * figure changes a great many pixels.
   */
  scaleSwing: number;
  /**
   * Least-squares slope of the figure's box area, as a fraction of mean area
   * per frame. NEGATIVE means shrinking. This, not `scaleSwing`, is what
   * separates a gallop (extends and returns, +0.42%/frame) from a recession
   * (monotonic, -4.11%/frame) — they can have similar swings.
   */
  scaleTrend: number;
}

const median = (xs: readonly number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[s.length >> 1] : (s[(s.length >> 1) - 1] + s[s.length >> 1]) / 2;
};

/**
 * Checks → verdict, in the shape the panel's `<pre>` already renders. Same
 * construction `ghost.ts` does inline; a hard failure rejects, a soft one only
 * downgrades to `usable`.
 */
function finish(checks: QaCheck[], opts: { label?: string }, tail: string[] = []): QaVerdict {
  const failed = checks.filter((c) => !c.pass);
  const level: QaLevel = failed.some((c) => !c.soft) ? "reject" : failed.length ? "usable" : "ready";
  const head = opts.label ? `${opts.label} — ${level.toUpperCase()}` : level.toUpperCase();
  const lines = checks.map((c) => {
    const m = c.pass ? "  ok " : c.soft ? "  !  " : "  ✗  ";
    const why = c.pass ? "" : `\n         ${c.why}\n         fix: ${c.fix}`;
    return `${m}${c.label.padEnd(26)} ${c.value}  (want ${c.want})${why}`;
  });
  return { level, checks, report: [head, ...lines, ...tail].join("\n") };
}

/**
 * Did this clip move? Run it on the RAW frames, in order.
 */
export function motionClip(frames: readonly RawImage[], opts: { label?: string } = {}): MotionVerdict {
  if (frames.length < 2) {
    return {
      ...finish([{
        id: "motion", label: "the clip moves", value: `${frames.length} frame(s)`, want: "≥ 2 frames",
        pass: false, soft: true,
        why: "a single frame cannot be checked for motion",
        fix: "generate the clip again with --frames 21",
      }], opts),
      // scaleSwing 0, not undefined: a clip too short to compare has not
      // changed size, and an optional field here would push the null check
      // onto every reader.
      churn: [], seam: 0, boxes: frames.length, scaleSwing: 0, scaleTrend: 0,
    };
  }

  const boxes = frames.map(figureBox);
  // ONE box for the whole clip — the union. Measuring each pair inside its own
  // box would move the denominator with the subject and quietly normalise away
  // the very travel being measured.
  const union: [number, number, number, number] = [
    Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])),
    Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3])),
  ];
  const pairs: number[] = [];
  for (let i = 1; i < frames.length; i++) pairs.push(churn(frames[i - 1], frames[i], union));
  const seam = churn(frames[frames.length - 1], frames[0], union);
  const med = median(pairs);
  const distinct = new Set(boxes.map((b) => b.join(","))).size;

  const frozen = med < MOTION.FROZEN;
  const checks: QaCheck[] = [{
    id: "motion",
    label: "the clip moves",
    value: `churn median ${pct(med)} (min ${pct(Math.min(...pairs))}, max ${pct(Math.max(...pairs))})`,
    want: `> ${pct(MOTION.FROZEN)}`,
    pass: !frozen,
    ...(frozen ? {
      why: "the frames are the same picture — played back this is a still photograph, not an animation",
      fix: "REGENERATE, do not curate. Picking the two least-identical frames out of a dead clip was tried and recorded as a dead end (7035534). For a subtle clip drop --loop first: pinning frame 1 == frame 21 lets the model satisfy both ends by holding still.",
    } : {}),
  }];

  if (!frozen && distinct / frames.length < MOTION.BOXES_SOFT) {
    checks.push({
      id: "silhouette", label: "the outline changes", value: `${distinct} distinct boxes of ${frames.length}`,
      want: `> ${Math.ceil(MOTION.BOXES_SOFT * frames.length)}`, pass: false, soft: true,
      why: "the interior moves but the silhouette is fixed — normal for a breathing idle, wrong for anything with legs",
      fix: "look at it at 8fps before keeping it; if it is a walk or a run, regenerate",
    });
  }

  /**
   * THE FIGURE MUST NOT CHANGE SIZE. See MOTION.SCALE_SWING_SOFT.
   *
   * Computed from the boxes already gathered above, so it costs nothing. It is
   * the one axis nothing downstream can repair: drift.ts registers by bounding
   * box, so a figure that halves is a new sprite rather than a pose.
   */
  const areas = boxes.map(([x0, y0, x1, y1]) => Math.max(0, x1 - x0 + 1) * Math.max(0, y1 - y0 + 1));
  const maxArea = Math.max(...areas);
  const swing = maxArea > 0 ? 1 - Math.min(...areas) / maxArea : 0;
  /**
   * Least-squares slope of area over frame index, normalised by the mean area,
   * so it reads as "fraction of the figure lost per frame". Negative is
   * shrinking. See MOTION.SCALE_TREND_SOFT for why this and not `swing`.
   */
  const meanArea = areas.reduce((a, b) => a + b, 0) / (areas.length || 1);
  const trend = (() => {
    const n = areas.length;
    if (n < 3 || meanArea <= 0) return 0;
    const mx = (n - 1) / 2;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (i - mx) * (areas[i] - meanArea); den += (i - mx) ** 2; }
    return den > 0 ? num / den / meanArea : 0;
  })();
  /**
   * SWING IS THE TRIGGER; TREND ONLY SAYS WHICH KIND. Do not swap them.
   *
   * This gate was briefly rewritten to fire on trend alone, on the theory that
   * N:run's 33% swing was a gallop extending and gathering and therefore a
   * false positive. It was not a gallop. The operator watched the clip: "the
   * dog just looks like it's rocking back and forth", and the frames confirm a
   * standing dog with a swinging tail whose whole body scales up and down.
   *
   * So the SWING check was right and the rewrite would have blinded it to the
   * commonest front/back failure there is. Both defects matter and they are
   * distinguished by shape, not magnitude:
   *
   *   swing high, trend ~0    ROCKING   toward/away from camera, no gait
   *   swing high, trend down  RECEDING  the figure shrinks away
   *   swing low               stable
   *
   * A real side-on gait barely swings at all — the approved S walk is 7.3%,
   * because a body extending sideways does not change its bounding area much.
   * "Big swing means a gait" was the wrong intuition; on this pipeline a big
   * swing is the defect, and only its direction varies.
   */
  if (swing > MOTION.SCALE_SWING_SOFT) {
    const receding = trend < -MOTION.SCALE_TREND_SOFT;
    checks.push({
      id: "scale", label: "the figure holds its size",
      value: `area swings ${pct(swing)}, trend ${(trend * 100).toFixed(2)}%/frame — ${receding ? "RECEDING" : "rocking toward/away"} (smallest frame ${areas.indexOf(Math.min(...areas))})`,
      want: `< ${pct(MOTION.SCALE_SWING_SOFT)} swing`, pass: false, soft: true,
      why: receding
        ? "the creature shrinks steadily across the clip — on a front facing this is how the model expresses forward motion, and churn REWARDS it because a receding figure changes a lot of pixels"
        : "the creature's size oscillates without a stride — it is rocking toward and away from the camera rather than moving its legs, which is what a gait looks like when the model has no lateral silhouette to work with",
      fix: receding
        ? "prompting does not fix it (measured: three variants, the shrink got worse each time, and Wan's negative already bans 'character shrinking'). Generate on a SIDE facing where the motion is perpendicular to the camera"
        : "a front/back facing gives a gait no lateral silhouette, so the model substitutes scale. Generate gaits on E, or drive the poses with --end keyframes instead of asking for free-running motion",
    });
  }

  // The per-frame table, for the same reason `ghost.ts` prints one: the numbers
  // are what made this diagnosable, and a boolean would hide the mechanism.
  const table = ["", "  churn% frame→next:", ...pairs.map((v, i) => `    ${String(i).padStart(3)}  ${pct(v).padStart(7)}`)];
  table.push(`    seam ${pct(seam).padStart(7)}  (last→first; a closed cycle sits near the median)`);
  return { ...finish(checks, opts, table), churn: pairs, seam, boxes: distinct, scaleSwing: swing, scaleTrend: trend };
}
