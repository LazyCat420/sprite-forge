/**
 * FADE — a frame that lost one of the creature's colours.
 *
 * ── THE DEFECT, AS REPORTED ─────────────────────────────────────────────────
 *
 * "the consistency of the colour of the subject — a couple frames in the walk
 * it started to fade." Reported by eye on the ONE APPROVED CLIP, which had
 * already passed every gate this pipeline has.
 *
 * Measured on `sources/dog-2026-08-07`, clustering the whole clip's figure
 * pixels into five colours and tracking each cluster's share per frame:
 *
 *     #05041a  body dark    median 45.6%   worst drop  6.7%
 *     #18162c  body dark    median 29.3%   worst drop  5.2%
 *     #342f3c  body mid     median 17.7%   worst drop  6.8%
 *     #6c6658  TAN PAWS     median  4.9%   worst drop 22.5%   <- frame 5
 *     #bfb8a5  CREAM PAWS   median  2.9%   worst drop 11.8%
 *
 * The three body clusters are stable within 7%. Only the paw markings collapse,
 * and the frames where they collapse (4, 5, 18, 19) are exactly the frames that
 * read as "the legs merged into a black blob".
 *
 * ── WHY `ghost.ts` CANNOT SEE THIS, AND IT IS NOT A THRESHOLD PROBLEM ───────
 *
 * Ghost scores pixels that are WASHED — blended toward the FIELD COLOUR — and
 * flat. **It is directional.** The tan paws here do not blend toward the white
 * background, they are absorbed into the creature's own BLACK BODY, which moves
 * the pixel the opposite way: further from the field, not closer. Ghost gave
 * this clip 0.36% worst and flagged nothing, correctly by its own definition.
 *
 * Ghost is also normalised WITHIN each frame — deliberately, so its numbers do
 * not just encode "a dark subject on a light field". That is a second reason it
 * is blind here: a frame that has quietly lost a feature is still internally
 * consistent, and consistency within a frame is all ghost ever looks at.
 *
 * This file is therefore not a better ghost. It is the cross-frame axis ghost
 * chose not to measure.
 *
 * ── WHAT IS MEASURED ────────────────────────────────────────────────────────
 *
 * One palette for the WHOLE clip (k-means over sampled figure pixels), then
 * each frame's share of each cluster. A frame is flagged when a cluster that is
 * substantial across the clip loses a large fraction of its share in that
 * frame.
 *
 * Clustering the clip rather than a master is deliberate: it needs no reference
 * art, so it runs at generation time on the raw frames, next to `ghost` and
 * `motion`, where the answer is still free to act on. `drift.ts` already
 * compares a cell's palette to a MASTER — that is a different and later
 * question ("is this the same creature as the reference"), and it runs after
 * matte and registration.
 *
 * ── THE SMALL-CLUSTER TRAP ──────────────────────────────────────────────────
 *
 * A cluster at 0.3% of the figure swings wildly for free — two dozen pixels of
 * antialiasing move it by half. Flagging those would bury every real finding,
 * so `MIN_SHARE` excludes them. The cost is honest and worth stating: **a
 * genuinely tiny feature, like the green eyes at well under 1%, is below this
 * gate's floor.** It catches the paws; it would not catch an eye going out.
 */
import type { QaCheck, QaLevel, QaVerdict } from "./intake-qa";
import type { RawImage } from "./resample";

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

export const FADE = {
  /** Palette size. Five separates body/mid/markings on the dog without splitting the body. */
  K: 5,
  /** Ink threshold against the field colour. */
  FIELD_TOL: 28,
  /** Clusters smaller than this are noise, not features. See the trap note above. */
  MIN_SHARE: 0.01,
  /** A cluster losing this fraction of its median share in one frame is a lost feature. */
  DROP: 0.4,
  /** Advisory band below the hard drop. The dog's tan hit 0.225 and was visible. */
  SOFT_DROP: 0.2,
  /** Pixels sampled for the k-means. Enough to be stable, small enough to be fast. */
  SAMPLE: 60000,
} as const;

function fieldColour(img: RawImage): [number, number, number] {
  const { width: w, height: h, data } = img;
  const ch: [number[], number[], number[]] = [[], [], []];
  const at = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    ch[0].push(data[i]); ch[1].push(data[i + 1]); ch[2].push(data[i + 2]);
  };
  for (let x = 0; x < w; x++) { at(x, 0); at(x, h - 1); }
  for (let y = 0; y < h; y++) { at(0, y); at(w - 1, y); }
  return ch.map((c) => c.sort((a, b) => a - b)[c.length >> 1]) as [number, number, number];
}

/** Figure pixels of one frame as a flat [r,g,b,...] array. */
function figurePixels(img: RawImage): number[] {
  const { width: w, height: h, data } = img;
  let matted = false;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 250) { matted = true; break; }
  const [fr, fg, fb] = matted ? [0, 0, 0] : fieldColour(img);
  const out: number[] = [];
  for (let p = 0, i = 0; p < w * h; p++, i += 4) {
    const ink = matted
      ? data[i + 3] > 16
      : Math.max(Math.abs(data[i] - fr), Math.abs(data[i + 1] - fg), Math.abs(data[i + 2] - fb)) > FADE.FIELD_TOL;
    if (ink) out.push(data[i], data[i + 1], data[i + 2]);
  }
  return out;
}

/**
 * k-means over sampled pixels. Seeded deterministically and initialised by
 * spreading across luminance — a k-means started at random on a mostly-black
 * dog puts every centre inside the body and never finds the paws, which is the
 * one cluster that matters here.
 */
function palette(sample: number[], k: number): number[][] {
  const n = sample.length / 3;
  const lum: { i: number; v: number }[] = [];
  for (let p = 0; p < n; p++) lum.push({ i: p, v: sample[p * 3] + sample[p * 3 + 1] + sample[p * 3 + 2] });
  lum.sort((a, b) => a.v - b.v);
  const cent: number[][] = [];
  for (let j = 0; j < k; j++) {
    const p = lum[Math.min(n - 1, Math.round((j * (n - 1)) / Math.max(1, k - 1)))].i;
    cent.push([sample[p * 3], sample[p * 3 + 1], sample[p * 3 + 2]]);
  }
  for (let iter = 0; iter < 20; iter++) {
    const sum = Array.from({ length: k }, () => [0, 0, 0, 0]);
    for (let p = 0; p < n; p++) {
      const r = sample[p * 3], g = sample[p * 3 + 1], b = sample[p * 3 + 2];
      let best = 0, bd = Infinity;
      for (let j = 0; j < k; j++) {
        const d = (r - cent[j][0]) ** 2 + (g - cent[j][1]) ** 2 + (b - cent[j][2]) ** 2;
        if (d < bd) { bd = d; best = j; }
      }
      sum[best][0] += r; sum[best][1] += g; sum[best][2] += b; sum[best][3]++;
    }
    for (let j = 0; j < k; j++) {
      if (sum[j][3]) cent[j] = [sum[j][0] / sum[j][3], sum[j][1] / sum[j][3], sum[j][2] / sum[j][3]];
    }
  }
  return cent;
}

const hex = (c: number[]) =>
  "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

export interface FadeVerdict extends QaVerdict {
  /** The clip's palette, as hex. */
  palette: string[];
  /** shares[frame][cluster], 0-1. */
  shares: number[][];
  /** Frames where a substantial cluster collapsed. */
  flagged: number[];
  /**
   * THE HEADLINE NUMBER, and it must be stored, not just printed.
   *
   * `level` alone is a three-valued summary, and every gait clip in the first
   * sweep came back `usable` — which says "something dimmed" for a 21% drop and
   * for a 39% one identically. Judging twenty clips needs the magnitude and the
   * frame, or the only way to rank them is to re-run the gate. `flagged` does
   * not help either: it stays EMPTY for every soft finding by design, because
   * soft frames are not droppable.
   *
   * `drop` is a fraction of the cluster's median share, not of the figure.
   */
  worst: { drop: number; colour: string; frame: number } | null;
}

const median = (xs: readonly number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[s.length >> 1] : (s[(s.length >> 1) - 1] + s[s.length >> 1]) / 2;
};

/**
 * Does every frame still wear the creature's colours? Run on RAW frames.
 */
export function fadeClip(frames: readonly RawImage[], opts: { label?: string } = {}): FadeVerdict {
  const empty = (checks: QaCheck[]): FadeVerdict => ({
    ...finish(checks, opts), palette: [], shares: [], flagged: [], worst: null,
  });
  if (frames.length < 2) {
    return empty([{
      id: "fade", label: "colours hold across the clip", value: `${frames.length} frame(s)`,
      want: "≥ 2 frames", pass: false, soft: true,
      why: "a single frame cannot drift", fix: "generate the clip",
    }]);
  }

  const perFrame = frames.map(figurePixels);
  const total = perFrame.reduce((s, f) => s + f.length / 3, 0);
  if (!total) {
    return empty([{
      id: "fade", label: "colours hold across the clip", value: "no figure found",
      want: "a subject on a field", pass: false, soft: true,
      why: "every frame keyed as empty — the field detection found no ink",
      fix: "check the frames are not blank and the background is not the same colour as the subject",
    }]);
  }

  // Even sample across frames so a long clip does not let late frames dominate.
  const perFrameQuota = Math.max(1, Math.floor(FADE.SAMPLE / frames.length));
  const sample: number[] = [];
  for (const f of perFrame) {
    const n = f.length / 3;
    const step = Math.max(1, Math.floor(n / perFrameQuota));
    for (let p = 0; p < n; p += step) sample.push(f[p * 3], f[p * 3 + 1], f[p * 3 + 2]);
  }
  const cent = palette(sample, FADE.K);

  const shares = perFrame.map((f) => {
    const n = f.length / 3;
    const count = new Array(FADE.K).fill(0);
    for (let p = 0; p < n; p++) {
      const r = f[p * 3], g = f[p * 3 + 1], b = f[p * 3 + 2];
      let best = 0, bd = Infinity;
      for (let j = 0; j < FADE.K; j++) {
        const d = (r - cent[j][0]) ** 2 + (g - cent[j][1]) ** 2 + (b - cent[j][2]) ** 2;
        if (d < bd) { bd = d; best = j; }
      }
      count[best]++;
    }
    return n ? count.map((c) => c / n) : count;
  });

  const checks: QaCheck[] = [];
  const flagged = new Set<number>();
  let worstDrop = 0, worstWho = "", worstColour = "", worstFrame = -1;
  for (let j = 0; j < FADE.K; j++) {
    const col = shares.map((s) => s[j]);
    const med = median(col);
    if (med < FADE.MIN_SHARE) continue;      // noise-sized cluster; see the trap note
    const lo = Math.min(...col);
    const drop = (med - lo) / med;
    const at = col.indexOf(lo);
    if (drop > worstDrop) { worstDrop = drop; worstWho = `${hex(cent[j])} at frame ${at}`; worstColour = hex(cent[j]); worstFrame = at; }
    if (drop >= FADE.DROP) {
      col.forEach((v, i) => { if ((med - v) / med >= FADE.DROP) flagged.add(i); });
    }
  }

  const hard = worstDrop >= FADE.DROP;
  const soft = !hard && worstDrop >= FADE.SOFT_DROP;
  checks.push({
    id: "fade",
    label: "colours hold across the clip",
    value: `worst ${pct(worstDrop)} loss — ${worstWho || "none"}`,
    want: `< ${pct(FADE.DROP)} of a colour's share`,
    pass: !hard,
    ...(hard ? {
      why: "a frame lost one of the creature's colours — a marking absorbed into the body, which reads as the detail fading in and out",
      fix: "drop the flagged frames, or regenerate. Note the negative already bans 'legs merging' and did not prevent it, so re-prompting is not the lever; a smaller canvas with more texels per feature is.",
    } : {}),
  });
  if (soft) {
    checks.push({
      id: "fade-soft", label: "a marking dims", value: `worst ${pct(worstDrop)} — ${worstWho}`,
      want: `< ${pct(FADE.SOFT_DROP)}`, pass: false, soft: true,
      why: "borderline. The dog walk's tan paws measured 22.5% here and the operator saw it unprompted",
      fix: "look at the named frame against a neighbour before publishing",
    });
  }

  return {
    ...finish(checks, opts, [
      "",
      "  palette: " + cent.map((c) => hex(c)).join(" "),
      ...shares.map((s, i) => `    ${String(i).padStart(3)}  ` + s.map((v) => pct(v).padStart(7)).join("")),
    ]),
    palette: cent.map((c) => hex(c)),
    shares,
    worst: worstFrame < 0 ? null : { drop: worstDrop, colour: worstColour, frame: worstFrame },
    flagged: [...flagged].sort((a, b) => a - b),
  };
}

/** Checks -> verdict, in the shape the panel's `<pre>` renders. */
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
