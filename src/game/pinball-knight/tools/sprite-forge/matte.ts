/**
 * MATTING — an opaque generated sheet into real alpha.
 *
 * THE STAGE THE PIPELINE WAS MISSING. Every sheet an image generator produces
 * arrives on an opaque white or cream field, because diffusion models have no
 * alpha channel to write. `sliceSheet` finds cells by alpha, so without this it
 * sees one connected region and returns a single cell — the sheet never gets
 * as far as being wrong, it just gets rejected.
 *
 * ── WHY A FLOOD FILL AND NOT A COLOUR KEY ───────────────────────────────────
 *
 * The obvious implementation is "make every pixel near the background colour
 * transparent". It is also the one that destroys the art, and this roster is
 * the worst possible case for it: the reference clown's RUFF, GLOVES, FACE and
 * trouser stripes are all white or near-white, on a cream field. A global key
 * punches holes through every one of them — the same failure as a white beard
 * reading as chainmail, arriving through a different door.
 *
 * Background is not a colour, it is a REGION: the part of the sheet you can
 * reach from the edge without crossing the art. So the fill starts at the
 * border and stops at the first outline it meets. Interior whites are
 * unreachable and survive untouched, with no tolerance tuning at all.
 *
 * Everything here is pure — pixels in, pixels and a report out. No canvas, no
 * DOM, no filesystem, so the browser refiner and the headless run share it.
 */

/**
 * Colour distance, luma-weighted to match the palette snap.
 *
 * The same 0.3 / 0.59 / 0.11 weighting `sprite.ts` quantizes with. Using plain
 * RGB distance here would mean the matte's idea of "near the background" and
 * the crush's idea of "near a palette entry" disagreed, and a tolerance tuned
 * against one would misbehave in the other.
 */
export function colourDist(
  r1: number, g1: number, b1: number,
  r2: number, g2: number, b2: number,
): number {
  const dr = (r1 - r2) * 0.3;
  const dg = (g1 - g2) * 0.59;
  const db = (b1 - b2) * 0.11;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

export type Rgb = [number, number, number];

/** A pocket of background colour the border fill could not reach. */
export interface EnclosedRegion {
  /** A pixel inside it — the stable id, and what a recipe stores. */
  seed: [number, number];
  area: number;
  bounds: [number, number, number, number];
}

export interface MatteOptions {
  /** Override the estimate. Give this when the sheet fools the border ring. */
  bg?: Rgb;
  /** Weighted distance within which a pixel counts as background. */
  tolerance?: number;
  /** Rings of background-contaminated fringe to remove after keying. */
  erode?: number;
  /** Seeds of small pockets to key anyway — authored in the UI, never guessed. */
  keyEnclosed?: [number, number][];
  /** Seeds of large pockets to KEEP opaque, overriding the auto-key below. */
  keepEnclosed?: [number, number][];
  /**
   * Pockets at least this share of the sheet are keyed automatically.
   *
   * ⚠️ A RULED SHEET SEALS EVERY CELL. The border fill stops at the frame, so
   * each cell's interior is an enclosed pocket the fill can never reach — on the
   * reference layout that is 19 boxes of ~8,000 px each, and leaving them opaque
   * means the sheet is not matted at all.
   *
   * Size separates them from art with room to spare: a cell interior measured
   * 8,066 px against a glove's 120 px, a 67x gap, and this default sits ~7x from
   * one and ~9x from the other. The principle is that a pocket this large is
   * STRUCTURE — a frame's inside, or a genuine hole through a creature, both of
   * which should be transparent — while the case that must never be keyed
   * blindly (a white glove, a ruff) is always small.
   *
   * Everything auto-keyed is listed in the report. Nothing here is silent.
   */
  autoKeyArea?: number;
}

export interface MatteReport {
  bg: Rgb;
  /** Share of the border ring that matched `bg`. Low means a busy border. */
  bgConfidence: number;
  /** Share of the sheet the fill removed. */
  keyedPct: number;
  /** Pockets left opaque, for a human to rule on. */
  enclosed: EnclosedRegion[];
  /** Pockets keyed on size alone — a ruled cell's interior, or a hole through art. */
  autoKeyed: EnclosedRegion[];
  warnings: string[];
  /** Non-empty means the result must not be used. */
  failures: string[];
}

/**
 * How far from the background colour a pixel can be and still be keyed.
 *
 * GENEROUS ON PURPOSE, and safe because the guard against eating art is
 * CONNECTIVITY, not colour distance. A pixel is only ever keyed if the fill can
 * walk to it from the sheet edge, so art enclosed by an outline is protected at
 * any tolerance at all — the clown's gloves sit 2.0 from the background and
 * survive a tolerance of 40 untouched. The only thing at risk is art that is
 * both background-coloured AND unenclosed, which the preview shows immediately.
 *
 * The value is what real sheets need. Measured on jester, whose furniture is a
 * grey outer frame at distance 26.2 and a dashed cell grid: the sheet welds into
 * one cell at every tolerance up to 24, and slices correctly at 36 and above.
 * Across that entire sweep the keyed share moves 75.7% -> 78.8%, so what the
 * extra tolerance removes is furniture, not art.
 *
 * A per-sheet value derived from the border band was tried first and is worse:
 * the frame is only ~9% of that band, so any sensible coverage target picks a
 * tolerance that leaves it standing.
 */
export const DEFAULT_TOLERANCE = 40;
/**
 * Enclosed pockets at least this share of the sheet are keyed automatically.
 *
 * Measured on the reference layout: a ruled cell's sealed interior is 8,066 px
 * and a glove is 120 px, of a 559,196 px sheet. 0.2% is 1,118 px — about 7x
 * below the structure and 9x above the art.
 */
export const AUTO_KEY_AREA = 0.002;
/**
 * The fill must be able to reach at least this much of the border band.
 *
 * Not a loose sanity check — a tight one, because the residue is what bites.
 * Measured on jester at tolerance 12: 88.8% of the border was reachable, and
 * the missing 11% survived as an opaque SPECKLE MESH threaded through the whole
 * background, welding every cell together so the sheet still sliced to one.
 * Anything under ~0.9 fails that way. At their own suggested tolerances the two
 * real sheets reach 99.9% and 100%.
 */
const MIN_BG_CONFIDENCE = 0.9;
/** A fill outside this band did not do what matting is supposed to do. */
const MIN_KEYED = 0.05;
const MAX_KEYED = 0.95;

/**
 * The modal colour of a border BAND.
 *
 * Corners alone are the usual shortcut and they are wrong here: a sheet drawn
 * with a ruled outer frame puts the FRAME LINE in every corner, so a corner
 * sample keys the border colour and leaves the whole field opaque.
 *
 * A 1px RING does not fix it either, and assuming otherwise cost a test: when
 * the frame is drawn ON the outermost pixels the ring is not "mostly
 * background with a bit of frame", it is 100% frame. Measured — the estimate
 * came back #281e1e, the ink colour.
 *
 * A band several pixels deep is the version that holds. A frame is 1-3px of a
 * band ~7px deep, so the field outvotes it several to one, and a sheet with a
 * margin outside its frame never sees the frame at all. A genuinely thick
 * decorative border would still win — and then keys almost nothing, which the
 * `keyedPct` gate rejects rather than shipping a sheet nobody matted.
 */
export function estimateBackground(
  data: Uint8ClampedArray, w: number, h: number, tol: number = DEFAULT_TOLERANCE,
): { bg: Rgb; confidence: number; suggestedTolerance: number } {
  const depth = Math.max(2, Math.min(12, Math.round(Math.min(w, h) * 0.01)));
  const inBand = (x: number, y: number): boolean =>
    x < depth || y < depth || x >= w - depth || y >= h - depth;
  // Quantised to 5 bits per channel so a gently dithered field still votes as
  // one colour instead of scattering across a hundred near-identical keys.
  const bucket = (i: number): number =>
    ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);

  const counts = new Map<number, number>();
  let total = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!inBand(x, y)) continue;
      const i = (y * w + x) * 4;
      if (data[i + 3] === 0) continue;
      const key = bucket(i);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      total++;
    }
  }
  if (!total) return { bg: [0, 0, 0], confidence: 0, suggestedTolerance: tol };

  let best = 0;
  let bestN = 0;
  for (const [key, n] of counts) if (n > bestN) { bestN = n; best = key; }

  // Average the members of the winning bucket rather than taking the bucket
  // centre — the centre is up to 4 units off in each channel, which is a real
  // error to hand a tolerance test.
  let sr = 0, sg = 0, sb = 0, n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!inBand(x, y)) continue;
      const i = (y * w + x) * 4;
      if (data[i + 3] === 0 || bucket(i) !== best) continue;
      sr += data[i]; sg += data[i + 1]; sb += data[i + 2]; n++;
    }
  }
  const bg: Rgb = [Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)];

  // ── CONFIDENCE IS MEASURED BY TOLERANCE, NOT BY EXACT COLOUR.
  //
  // Counting the modal bucket's share says "no dominant colour" for a
  // background that is perfectly keyable. Both real sheets tested arrive with a
  // faint transparency CHECKERBOARD baked into the pixels — jester alternates
  // rgb(252) and rgb(243), beaver rgb(253) and rgb(246) — so the mode is 44%
  // and 53% and the gate rejected them. Within a tolerance of 8 the same bands
  // are 84% and 100% uniform.
  //
  // The quantity that matters is the one the fill actually uses: how much of
  // the border is reachable at the tolerance in play.
  const share = (t: number): number => {
    let k = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!inBand(x, y)) continue;
        const i = (y * w + x) * 4;
        if (data[i + 3] === 0) continue;
        if (colourDist(data[i], data[i + 1], data[i + 2], bg[0], bg[1], bg[2]) <= t) k++;
      }
    }
    return k / total;
  };
  // The smallest tolerance that would cover the band — so a failure can say
  // what to change instead of only that something is wrong.
  const ladder = [4, 8, 12, 16, 24, 32, 48, 64];
  const suggestedTolerance = ladder.find((t) => share(t) >= 0.95) ?? ladder[ladder.length - 1];
  return { bg, confidence: share(tol), suggestedTolerance };
}

/**
 * Key the background out of a sheet. Returns a NEW buffer; the input is not
 * modified, so the UI can re-run with different options against one source.
 */
export function matte(
  data: Uint8ClampedArray, w: number, h: number, opts: MatteOptions = {},
): { data: Uint8ClampedArray; report: MatteReport } {
  const tol = opts.tolerance ?? DEFAULT_TOLERANCE;
  const est = estimateBackground(data, w, h, tol);
  const bg = opts.bg ?? est.bg;
  const warnings: string[] = [];
  const failures: string[] = [];

  const out = new Uint8ClampedArray(data);
  const near = (i: number): boolean =>
    data[i + 3] > 0 && colourDist(data[i], data[i + 1], data[i + 2], bg[0], bg[1], bg[2]) <= tol;

  // ── The fill. Iterative with an explicit stack: a sheet is millions of
  // pixels and recursion would blow the call stack on the first real input.
  const keyed = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (p: number): void => {
    if (keyed[p] || !near(p * 4)) return;
    keyed[p] = 1;
    stack.push(p);
  };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (stack.length) {
    const p = stack.pop() as number;
    const x = p % w;
    const y = (p / w) | 0;
    if (x > 0) push(p - 1);
    if (x < w - 1) push(p + 1);
    if (y > 0) push(p - w);
    if (y < h - 1) push(p + w);
  }

  // ── Pockets of background colour the fill could not reach.
  //
  // NEVER keyed automatically beyond the speck threshold. The inside of a
  // spring coil is background; a white glove is not; and both are "a
  // background-coloured region enclosed by outline". Guessing deletes the
  // glove. So they are reported, the UI shows them, and the recipe records the
  // human's answer — which is also what makes the run reproducible.
  const autoArea = (opts.autoKeyArea ?? AUTO_KEY_AREA) * w * h;
  const wanted = new Set((opts.keyEnclosed ?? []).map(([x, y]) => y * w + x));
  const kept = new Set((opts.keepEnclosed ?? []).map(([x, y]) => y * w + x));
  const enclosed: EnclosedRegion[] = [];
  const autoKeyed: EnclosedRegion[] = [];
  const seen = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) {
    if (keyed[p] || seen[p] || !near(p * 4)) continue;
    const region: number[] = [];
    const q = [p];
    seen[p] = 1;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    let hit = false;
    while (q.length) {
      const c = q.pop() as number;
      region.push(c);
      if (wanted.has(c)) hit = true;
      const x = c % w;
      const y = (c / w) | 0;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      const nb = [x > 0 ? c - 1 : -1, x < w - 1 ? c + 1 : -1, y > 0 ? c - w : -1, y < h - 1 ? c + w : -1];
      for (const n2 of nb) {
        if (n2 < 0 || seen[n2] || keyed[n2] || !near(n2 * 4)) continue;
        seen[n2] = 1;
        q.push(n2);
      }
    }
    const info: EnclosedRegion = {
      seed: [region[0] % w, (region[0] / w) | 0], area: region.length, bounds: [x0, y0, x1, y1],
    };
    const held = region.some((c) => kept.has(c));
    const auto = !held && region.length >= autoArea;
    if (hit || auto) {
      for (const c of region) keyed[c] = 1;
      if (auto) autoKeyed.push(info);
      continue;
    }
    enclosed.push(info);
  }

  // ── Fringe.
  //
  // A generator's edges are antialiased, so between the field and the outline
  // sits a ramp of background-tinted pixels. They survive the tolerance test,
  // then snap to whatever palette entry is nearest and ring the sprite in a
  // colour nobody authored. Eroding rings of *background-leaning* pixels — not
  // every edge pixel — removes the ramp without shaving the outline.
  const rings = opts.erode ?? 0;
  for (let r = 0; r < rings; r++) {
    const drop: number[] = [];
    for (let p = 0; p < w * h; p++) {
      if (keyed[p]) continue;
      const x = p % w;
      const y = (p / w) | 0;
      const edge =
        (x > 0 && keyed[p - 1]) || (x < w - 1 && keyed[p + 1]) ||
        (y > 0 && keyed[p - w]) || (y < h - 1 && keyed[p + w]);
      if (!edge) continue;
      const i = p * 4;
      if (colourDist(data[i], data[i + 1], data[i + 2], bg[0], bg[1], bg[2]) <= tol * 3) drop.push(p);
    }
    for (const p of drop) keyed[p] = 1;
  }

  let n = 0;
  for (let p = 0; p < w * h; p++) {
    if (!keyed[p]) continue;
    out[p * 4 + 3] = 0;
    n++;
  }
  const keyedPct = n / (w * h);

  // ── Refuse to guess.
  if (est.confidence < MIN_BG_CONFIDENCE && !opts.bg) {
    failures.push(
      `only ${(est.confidence * 100).toFixed(0)}% of the border is within tolerance ${tol} of ` +
        `${rgbHex(bg)} — a gradient or vignette cannot be keyed. ` +
        (est.suggestedTolerance > tol
          ? `Try { "matte": { "tolerance": ${est.suggestedTolerance} } } — that covers 95% of it.`
          : `Set a background colour explicitly, or re-export the sheet flat.`),
    );
  }
  if (keyedPct < MIN_KEYED) {
    failures.push(
      `only ${(keyedPct * 100).toFixed(1)}% of the sheet was removed — the background is not ` +
        `${rgbHex(bg)}, or it is already transparent.`,
    );
  }
  if (keyedPct > MAX_KEYED) {
    failures.push(
      `${(keyedPct * 100).toFixed(1)}% of the sheet was removed — the tolerance is eating the art.`,
    );
  }
  if (enclosed.length) {
    warnings.push(
      `${enclosed.length} enclosed background-coloured pocket(s) left opaque. Inspect them: a ` +
        `spring's inside should be keyed, a white glove must not be.`,
    );
  }
  if (autoKeyed.length) {
    warnings.push(
      `${autoKeyed.length} pocket(s) keyed on size alone (>= ${((opts.autoKeyArea ?? AUTO_KEY_AREA) * 100).toFixed(2)}% of ` +
        `the sheet) — a ruled sheet seals every cell, and those interiors are background. ` +
        `Pass keepEnclosed with a seed to hold one open.`,
    );
  }
  return {
    data: out,
    report: { bg, bgConfidence: est.confidence, keyedPct, enclosed, autoKeyed, warnings, failures },
  };
}

export function rgbHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

export function matteOpaque(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  opts: MatteOptions = {},
): Uint8ClampedArray {
  return matte(data, w, h, opts).data;
}
