/**
 * IS THIS FRAME WORTH GENERATING FROM?
 *
 * The checkpoint between "an image" and twenty-four keyframes. Everything
 * downstream inherits this frame's framing, scale and identity, so a bad one is
 * not a bad frame — it is six wasted sheets, and the reason will not be obvious
 * by then. This asks the questions the later stages will silently answer badly.
 *
 * THREE-VALUED, deliberately:
 *   ready   every check passed
 *   usable  it will produce art, at a named cost — the operator decides
 *   reject  something downstream provably breaks
 *
 * A boolean would be a lie in both directions: a 0.69 subject height is not a
 * failure, and a two-figure frame is not a warning.
 *
 * EVERY THRESHOLD IS SOMEONE ELSE'S CONSTANT where one exists. Intake's job is
 * to make the downstream gate pass, so intake's threshold IS that gate rather
 * than a looser cousin that lets a frame through to fail later.
 *
 * ⚠️ Pure. No `canvas`, no `node:fs` (`testkit-boundary.test.ts`).
 */
import { blobs, subjectOf } from "./blobs";
import { clearShare } from "./sheet-cut";
import { detectPixelGrid } from "./grid";
import { estimateBackground, matte, rgbHex } from "./matte";
import { sliceSheet } from "./slice";
import { FEET, SUBJECT_H, SUBJECT_H_TOL, SUBJECT_W_MAX, ANCHOR_TOL_PX } from "./intake";
import type { RawImage } from "./resample";

export type QaLevel = "ready" | "usable" | "reject";

export interface QaCheck {
  id: string;
  label: string;
  /** What was measured, already formatted for a human. */
  value: string;
  /** What it had to be. */
  want: string;
  pass: boolean;
  /** Only when it failed: what breaks, and what to do. */
  why?: string;
  fix?: string;
  /** A failure of this check is advisory, not fatal. */
  soft?: boolean;
}

export interface QaVerdict {
  level: QaLevel;
  checks: QaCheck[];
  /** Plain text, for the <pre> the panel already renders. */
  report: string;
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

/**
 * @param sourceH the subject's height in the ORIGINAL image, when known — the
 *   honest denominator for "is this an upscale of nothing".
 */
export function qaFrame(img: RawImage, opts: { sourceH?: number; afterStyle?: boolean } = {}): QaVerdict {
  const { width: w, height: h, data } = img;
  const checks: QaCheck[] = [];
  const add = (c: QaCheck) => checks.push(c);

  // ── 1. is there alpha at all ────────────────────────────────────────────
  // `OPAQUE_BELOW` (0.05) only means "someone keyed this". A frame meeting the
  // contract clears 20% of a square canvas even at the widest legal subject,
  // so 0.20 is a real assertion rather than a restatement of that constant.
  const clear = clearShare(data);
  add({
    id: "alpha",
    label: "background is transparent",
    value: pct(clear),
    want: "≥ 20%",
    pass: clear >= 0.2,
    why: "the frame is opaque — segmentation did not run, or the alpha was lost in a re-encode",
    fix: "run the cut-out step, or re-import the PNG without flattening it",
  });

  // ── 2. exactly one figure ───────────────────────────────────────────────
  const all = blobs(data, w, h);
  const { subject, extras, specks } = subjectOf(all);
  const figures = subject ? 1 + extras.length : 0;
  add({
    id: "one-figure",
    label: "one connected figure",
    value: `${figures}${specks.length ? ` (+${specks.length} speck${specks.length > 1 ? "s" : ""})` : ""}`,
    want: "exactly 1",
    pass: figures === 1,
    soft: figures === 2 || figures === 3,
    why:
      figures === 0
        ? "nothing survived the key"
        : "registration is by bounding box, so a detached piece moves the centre and the body shifts the other way",
    fix: figures > 1 ? "drop the extra piece, or brush it out of the mask" : "lower the mask threshold",
  });

  if (!subject) {
    return finish(checks, "no subject — every later check is meaningless");
  }

  // ── 3. sane share of the canvas ─────────────────────────────────────────
  const [bx0, by0, bx1, by1] = subject.bbox;
  const bh = (by1 - by0 + 1) / h;
  const bw = (bx1 - bx0 + 1) / w;
  // ── THE BINDING AXIS, NOT THE HEIGHT ────────────────────────────────────
  //
  // `reframeSubject` scales by `min(targetH/height, W_MAX/width)` — it fits the
  // subject inside BOTH bounds and lets whichever one binds decide. Asking only
  // about height therefore fails every subject wider than about 1:1 **for doing
  // exactly what the reframe told it to do**. A hound (a horizontal quadruped)
  // lands at 75.0% wide — its cap, to the tenth — and 42.8% tall, and this read
  // "figure fills the frame ✖, 42.8% tall (want 68.0%–76.0%)" and rejected it.
  // No reframe could have passed: 68% tall at that aspect is 108% wide.
  //
  // So the question is whether the subject is AT the cap on the axis that bound
  // it, with the other axis inside its own bound.
  const hOk = Math.abs(bh - SUBJECT_H) <= SUBJECT_H_TOL;
  const wOk = Math.abs(bw - SUBJECT_W_MAX) <= SUBJECT_H_TOL;
  const inBounds = bh <= SUBJECT_H + SUBJECT_H_TOL && bw <= SUBJECT_W_MAX;
  add({
    id: "size",
    label: "figure fills the frame",
    value: `${pct(bh)} tall, ${pct(bw)} wide — ${bw / bh > 1 ? "wide" : "tall"} subject`,
    want: `${pct(SUBJECT_H - SUBJECT_H_TOL)}–${pct(SUBJECT_H + SUBJECT_H_TOL)} tall, or ≤ ${pct(SUBJECT_W_MAX)} wide and at that cap`,
    pass: (hOk || wOk) && inBounds,
    // Only a figure so small the style pass has nothing to work with is fatal —
    // and "small" is about the LONG axis for the same reason as above.
    soft: Math.max(bh, bw) >= 0.5,
    why:
      Math.max(bh, bw) < 0.5
        ? "the style pass will spend its resolution on empty canvas"
        : "keyframes re-pose from this frame — a raised arm needs headroom",
    fix: "re-frame (free, no GPU)",
  });

  // ── 4. feet on the line, and nothing below them ─────────────────────────
  // `register.ts:72-80` plants the LOWEST ink on the floor, so a shadow or
  // plinth lifts the character. A shelf is wide and flat; a leg is not.
  const feetWant = Math.round(FEET * h);
  const feetOff = Math.abs(by1 - feetWant);
  // Measured against the figure's OWN median row width, not its bounding box.
  // A shelf is wider than the body that stands on it; a bounding box is by
  // definition as wide as the widest part, so comparing to it calls every
  // broad-shouldered creature a shadow.
  const widths: number[] = [];
  for (let y = by0; y <= by1; y++) {
    let n = 0;
    for (let x = bx0; x <= bx1; x++) if (data[(y * w + x) * 4 + 3] >= 128) n++;
    widths.push(n);
  }
  const median = [...widths].sort((a, b) => a - b)[widths.length >> 1] || 1;
  const band = Math.max(1, Math.round(widths.length * 0.05));
  const bottomWidest = Math.max(...widths.slice(-band)) / median;
  add({
    id: "feet",
    label: "feet on the ground line",
    value: `y=${by1} (want ${feetWant}), bottom band ${bottomWidest.toFixed(2)}× the body`,
    want: `±${ANCHOR_TOL_PX}px, band ≤ 1.15× body`,
    pass: feetOff <= ANCHOR_TOL_PX && bottomWidest <= 1.15,
    soft: true,
    why: "a ground shadow or plinth below the feet lifts the character off the floor in every frame",
    fix: "re-frame with 'strip the ground shelf' (free)",
  });

  // ── 5. centred on the same anchor the importer will use ─────────────────
  const centre = (bx0 + bx1 + 1) / 2;
  add({
    id: "centre",
    label: "centred",
    value: `x=${centre.toFixed(0)} (want ${w / 2})`,
    want: `±${ANCHOR_TOL_PX}px`,
    pass: Math.abs(centre - w / 2) <= ANCHOR_TOL_PX,
    soft: true,
    why: "the importer centres on the bounding box; disagreeing here shows up as a pop between frames",
    fix: "re-frame (free)",
  });

  // ── 6. nothing clipped at the edge ──────────────────────────────────────
  add({
    id: "clip",
    label: "nothing touching the canvas edge",
    value: subject.touchesEdge ? "the figure reaches the border" : "clear",
    want: "clear",
    pass: !subject.touchesEdge,
    why: "a clipped limb stays clipped in all twenty-four keyframes",
    fix: "re-frame at a smaller subject height",
  });

  // ── 6b. the subject is a FIGURE, not a filled block ─────────────────────
  //
  // THE STATE NO OTHER CHECK HERE CAN SEE. `alpha` and `matte` both branch on
  // `clearShare` — the transparent share of the WHOLE canvas — which the
  // reframe's own letterbox padding supplies no matter what the subject is. So
  // an unkeyed generation, reframed into a solid white rectangle with the
  // character buried inside it, cleared `alpha` at 49% and was then told by
  // `matte` that it was "already transparent". Two checks reporting healthy on
  // a frame with no matte at all, because both were reading the padding.
  //
  // A silhouette answers it directly: a real character never fills its own
  // bounding box — arms, legs and the gaps between them are holes. Measured
  // over every cell of every published sheet in the roster (brute, jester,
  // frog, mario, pinball_knight, zombie, beaver), the fullest cell in the
  // roster is the frog at 0.796 and the roster mean is 0.50. A filled
  // rectangle is 1.00. The gate sits at 0.92 — clear of the busiest real
  // sprite by a wide margin, and only reachable by something that is not a
  // silhouette.
  const fill = subject.area / Math.max(1, (bx1 - bx0 + 1) * (by1 - by0 + 1));
  add({
    id: "silhouette",
    label: "subject is a figure, not a block",
    value: `${pct(fill)} of its own bounding box`,
    want: "< 92%",
    pass: fill < 0.92,
    why: "the subject fills its box like a rectangle — the background was never keyed, so the 'sprite' is the whole frame",
    fix: "run the cut-out step before reframing; a raw generation has no alpha",
  });

  // ── 7. the matte can key it ─────────────────────────────────────────────
  //
  // ONLY ASKED OF AN OPAQUE FRAME. `sheet-cut.ts` mattes exactly when the sheet
  // has no usable alpha (`clearShare < OPAQUE_BELOW`), because a keyed frame
  // has nothing left to key — and running the matte anyway reads the RGB under
  // transparent pixels, decides the background is whatever that garbage says,
  // and reports 0% confidence on a frame that is already perfect. Intake's
  // segmented frames arrive WITH alpha; the styled frame that comes back from
  // Qwen does not, and that is the one this check is for.
  if (clear >= 0.05) {
    add({
      id: "matte",
      label: "background is keyable",
      value: "already transparent",
      want: "keyable or keyed",
      pass: true,
    });
  } else try {
    const est = estimateBackground(data, w, h);
    const rep = matte(data, w, h).report;
    add({
      id: "matte",
      label: "background is keyable",
      value: `${rgbHex(rep.bg)} at ${pct(rep.bgConfidence)} confidence, keyed ${pct(rep.keyedPct)}`,
      want: "≥ 90% confidence, 5–95% keyed",
      pass: rep.failures.length === 0,
      why:
        rep.failures[0] ??
        "the import mattes before it slices; a background it cannot key slices into one cell",
      fix: `raise the matte tolerance (try ${est.suggestedTolerance}) in the sheet tab`,
    });
    if (rep.enclosed?.length) {
      add({
        id: "pockets",
        label: "enclosed background pockets",
        value: `${rep.enclosed.length}`,
        want: "informational",
        pass: true,
        soft: true,
        why: "background-coloured areas inside the silhouette stay opaque by design — a white glove must not be keyed",
      });
    }
  } catch (e) {
    add({
      id: "matte",
      label: "background is keyable",
      value: e instanceof Error ? e.message : String(e),
      want: "a keyable field",
      pass: false,
      why: "the matte threw on this frame",
      fix: "flatten the frame onto white",
    });
  }

  // ── 8. the slicer sees exactly one cell ─────────────────────────────────
  // Today "sliced into 1 cell" reads as a bug; for ONE idle frame it is the
  // correct answer, so intake asserts it positively.
  try {
    const rows = sliceSheet(data, w, h);
    const cells = rows.reduce((n, r) => n + r.cells.length, 0);
    add({
      id: "slice",
      label: "slices as a single cell",
      value: `${rows.length} row(s), ${cells} cell(s)`,
      want: "1 row, 1 cell",
      pass: rows.length === 1 && cells === 1,
      why: "the slicer sees more than one figure — a caption, a border, or a second component",
      fix: "drop the extra piece or brush it out",
    });
  } catch {
    /* the alpha check above already explains a frame the slicer cannot read */
  }

  // ── 9. honest upscale advisory ──────────────────────────────────────────
  if (opts.sourceH) {
    const up = (by1 - by0 + 1) / opts.sourceH;
    add({
      id: "upscale",
      label: "resolution actually present",
      value: `${up.toFixed(1)}× upscale from ${opts.sourceH}px`,
      want: "≤ 4×",
      pass: up <= 4,
      soft: true,
      why: "beyond ~4× the style pass is inventing detail, not recovering it",
      fix: "start from a larger crop of the source, if one exists",
    });
  }

  // ── 10. pixel-grid verdict ───────────────────────────────────────────────
  //
  // THIS USED TO BE `pass: true`, HARDCODED, LABELLED "information, never a
  // gate". A check that passes for both states is not a check, and this one had
  // a job: it is the only thing in the forge that can tell art DRAWN on a pixel
  // lattice from a smooth painting that will be crushed onto one.
  //
  // What it cost, on 2026-08-07: a full brute moveset generated as continuous
  // anti-aliased art carried a `grid` line reading "continuous — will be
  // resampled" and still finished READY, because the line could not fail. It
  // was published and rejected on sight, and reverted in 7035534. Every other
  // check in this file measures the crush's OUTPUT — coverage, isolated texels,
  // matte keying — and the crush makes any input look like pixel art, which is
  // exactly why `commit.ts`'s post-reduce report scored the rejected sheet and
  // the liked one identically at `×8, confidence 100%, cell purity 100%`.
  //
  // SOFT, not hard, and deliberately. Every sanctioned import in the tree today
  // (jester, rotortail, croaker, fish_feet) came in as continuous art and works;
  // a hard gate would reject the existing roster to make a point. Soft moves the
  // verdict from READY to USABLE, which is the honest description — this art can
  // ship, and it is not what it claims to be.
  if (opts.afterStyle) {
    const grid = detectPixelGrid({ width: w, height: h, data }, [[bx0, by0, bx1, by1]]);
    add({
      id: "grid",
      label: "pixel lattice",
      value: grid.gridded ? `×${grid.factor} — imports 1:1` : "continuous — will be resampled",
      want: "drawn on a lattice",
      pass: grid.gridded,
      soft: true,
      why: grid.verdict,
      fix: "this is generated-illustration shape, not pixel art. Nothing downstream can add a lattice that the art does not have — the crush only imposes one. See docs/PLAN_KEYFRAME_PIPELINE.md.",
    });
  }

  return finish(checks);
}

function finish(checks: QaCheck[], note?: string): QaVerdict {
  const hard = checks.filter((c) => !c.pass && !c.soft);
  const soft = checks.filter((c) => !c.pass && c.soft);
  const level: QaLevel = hard.length ? "reject" : soft.length ? "usable" : "ready";
  const lines = [
    `VERDICT ${level.toUpperCase()}${note ? ` — ${note}` : ""}`,
    ...checks.map(
      (c) => `${c.pass ? "  ok " : c.soft ? "  ~  " : "  ✖  "}${c.label.padEnd(30)} ${c.value}   (want ${c.want})`,
    ),
    ...(hard.length || soft.length
      ? ["", ...[...hard, ...soft].map((c) => `${c.pass ? "" : "· "}${c.why ?? ""}${c.fix ? ` → ${c.fix}` : ""}`)]
      : []),
  ];
  return { level, checks, report: lines.join("\n") };
}
