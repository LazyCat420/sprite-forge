/**
 * INTAKE GEOMETRY — an arbitrary image becomes a frame the pipeline can use.
 *
 * Everything downstream inherits this frame's framing, scale and identity: the
 * keyframe sheets re-pose FROM it, the cut registers by its bounding box, the
 * crush spends its resolution on whatever share of the canvas the figure took.
 * So intake is not a convenience wrapper around a resize — it is the stage that
 * decides whether any of the following stages can succeed.
 *
 * ⚠️ PIXELS IN, PIXELS OUT. No `canvas`, no `node:fs` (`testkit-boundary.test.ts`).
 * The route decodes and encodes; these functions only think.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ────────────────────────────────────────────
 * No palette mapping and no outline pass, even though `prep/pixelize.mjs` has
 * both and they would make the preview look "more finished". Quantising here
 * would crush the frame before Qwen ever sees it, and would be a SECOND
 * canonical reduce — the thing `comfy/graphs.mjs`'s header argues against and
 * the reason imported and generated art currently agree. The crush stays in
 * `commit.ts`.
 */
import { blobs, subjectOf, unionBox, type Blob } from "./blobs";
import { matte } from "./matte";
import { resampleCell, type RawImage } from "./resample";

/**
 * Does this frame carry a real alpha channel, or is it a flat opaque
 * generation? One transparent pixel anywhere is enough to say "someone keyed
 * this": a reframed sprite always has a transparent margin, and a diffusion
 * output never has one.
 */
function hasAlpha(data: Uint8ClampedArray): boolean {
  for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return true;
  return false;
}

/**
 * THE CONTRACT, as numbers.
 *
 * `SUBJECT_H` 0.72 and `FEET` 0.90 are not taste. The engine plants feet at
 * `ART_GROUND / ART_BOX` = 118/128 = 0.922 and fits art into `ART_FIT_H` 110 of
 * a 128 box (see `manifest.ts`), so a frame authored at those proportions
 * registers without the importer having to rescale it. The remaining headroom
 * is spent deliberately: `keyframes` re-poses from this frame, and a raised
 * sword or a leaping crouch must have somewhere to go that is not off-canvas.
 */
export const INTAKE_PX = 1024;
export const SUBJECT_H = 0.72;
export const SUBJECT_H_TOL = 0.04;
export const SUBJECT_W_MAX = 0.75;
export const FEET = 0.9;
export const ANCHOR_TOL_PX = 2;
/** Mid-grey, not white: a white-clad subject on white is the worst case for a saliency head. */
export const LETTERBOX_RGB: readonly [number, number, number] = [128, 128, 128];

export interface Framed {
  image: RawImage;
  /** Subject bounds in the OUTPUT frame. */
  bbox: [number, number, number, number];
  feetY: number;
  centreX: number;
  /** Scale applied to the source subject. >1 means detail was invented, not recovered. */
  scale: number;
  /** Source subject height in source pixels — the honest upscale denominator. */
  sourceH: number;
  notes: string[];
}

const px = (img: RawImage, x: number, y: number) => (y * img.width + x) * 4;

/** A blank RGBA image filled with one colour (alpha 255 unless given). */
export function fill(w: number, h: number, rgb: readonly [number, number, number], a = 255): RawImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = a;
  }
  return { width: w, height: h, data };
}

/** Copy `src` into `dst` at (dx,dy), source-over. Clipped, never wrapping. */
export function blit(dst: RawImage, src: RawImage, dx: number, dy: number): void {
  for (let y = 0; y < src.height; y++) {
    const ty = dy + y;
    if (ty < 0 || ty >= dst.height) continue;
    for (let x = 0; x < src.width; x++) {
      const tx = dx + x;
      if (tx < 0 || tx >= dst.width) continue;
      const s = px(src, x, y);
      const a = src.data[s + 3];
      if (!a) continue;
      const d = px(dst, tx, ty);
      if (a === 255) {
        dst.data[d] = src.data[s];
        dst.data[d + 1] = src.data[s + 1];
        dst.data[d + 2] = src.data[s + 2];
        dst.data[d + 3] = 255;
        continue;
      }
      const k = a / 255;
      dst.data[d] = src.data[s] * k + dst.data[d] * (1 - k);
      dst.data[d + 1] = src.data[s + 1] * k + dst.data[d + 1] * (1 - k);
      dst.data[d + 2] = src.data[s + 2] * k + dst.data[d + 2] * (1 - k);
      dst.data[d + 3] = Math.max(dst.data[d + 3], a);
    }
  }
}

/**
 * Fit an image inside a square WITHOUT changing its aspect ratio.
 *
 * The model's latent is square (`qwenEdit` 1024², `wanI2V` 640²), and handing
 * it a 3:4 phone photo lets it decide the reframe — which is how a subject
 * ends up cropped or off-centre before anything has measured it. Letterboxing
 * makes that decision here, where it can be recorded and undone.
 */
export function letterbox(src: RawImage, size = INTAKE_PX): { image: RawImage; scale: number; dx: number; dy: number } {
  const k = Math.min(size / src.width, size / src.height);
  const w = Math.max(1, Math.round(src.width * k));
  const h = Math.max(1, Math.round(src.height * k));
  const scaled = w === src.width && h === src.height ? src : resampleCell(src, w, h, "box");
  const out = fill(size, size, LETTERBOX_RGB);
  const dx = Math.round((size - w) / 2);
  const dy = Math.round((size - h) / 2);
  blit(out, scaled, dx, dy);
  return { image: out, scale: k, dx, dy };
}

/** Crop an image to inclusive bounds. */
export function crop(src: RawImage, box: [number, number, number, number]): RawImage {
  const [x0, y0, x1, y1] = box;
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const out: RawImage = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  for (let y = 0; y < h; y++) {
    const s = ((y0 + y) * src.width + x0) * 4;
    out.data.set(src.data.subarray(s, s + w * 4), y * w * 4);
  }
  return out;
}

export interface ReframeOptions {
  size?: number;
  subjectH?: number;
  feet?: number;
  /** Keep detached pieces (a dropped weapon) rather than only the largest blob. */
  keepExtras?: boolean;
  /** Drop opaque rows in the bottom band that read as a shelf/shadow. */
  stripShelf?: boolean;
}

/**
 * THE REFRAME: crop to the subject, scale it to the contract, plant its feet.
 *
 * This is `prep/prep-sheet.mjs`'s scale+baseline block and `register.ts`'s
 * `registerCell` doing the same arithmetic for one image with intake's
 * constants — deliberately the same shape, because the importer will later
 * register this frame by bounding box and the two must agree rather than
 * merely be close.
 *
 * Resampling is `resampleCell(..., "box")` and never a canvas `drawImage`:
 * everything downstream is measured against that filter, and the browser's
 * smoothed downscale samples 2×2 and skips most of the source (see
 * `resample.ts`).
 */
export function reframeSubject(src: RawImage, opts: ReframeOptions = {}): Framed {
  const size = opts.size ?? INTAKE_PX;
  const targetH = opts.subjectH ?? SUBJECT_H;
  const feet = opts.feet ?? FEET;
  const notes: string[] = [];

  // ── AN OPAQUE FRAME IS KEYED BEFORE IT IS MEASURED ─────────────────────────
  //
  // Everything below finds the subject by ALPHA. Every raw generation is
  // OPAQUE — diffusion models have no alpha channel to write, which is the
  // premise matte.ts opens with — so on a Qwen or Wan frame the "subject" blob
  // was the entire canvas. The reframe then dutifully scaled that whole white
  // field to subject height and planted its feet: the output was a white
  // RECTANGLE with the character somewhere inside it, and every later stage
  // accepted it.
  //
  // Nothing downstream could say so. `qaFrame`'s alpha and matte checks both
  // branch on the transparent SHARE of the canvas, which this function's own
  // letterbox padding supplies whether the subject is a sprite or a block —
  // they reported 49% clear and "already transparent" on a frame with no matte
  // at all. (The `silhouette` check in intake-qa.ts is the one that can now
  // tell those two states apart, and it exists because of this bug.)
  //
  // Every caller that reframes a GENERATION rather than a cut-out was hit:
  // `scripts/build-character.mjs`'s rotate step — so the S and N masters of
  // every unattended build — and any panel intake that skips the cut-out.
  //
  // Keying here rather than at the call sites because this is the function
  // with the alpha requirement; a fix in one route would leave the CLI and the
  // build script still wrong. The fill is matte's border flood, so an interior
  // white (a tank top, an eye, the knight's own armour) is unreachable and
  // survives untouched — see the WHY A FLOOD FILL note in matte.ts. Guarded on
  // "is anything transparent at all", so an already-keyed frame is passed
  // through byte-for-byte and the cut-out path is unaffected.
  if (!hasAlpha(src.data)) {
    src = { width: src.width, height: src.height, data: matte(src.data, src.width, src.height).data };
    notes.push("keyed an opaque frame before measuring it — a raw generation carries no alpha");
  }

  const all = blobs(src.data, src.width, src.height);
  const { subject, extras, specks } = subjectOf(all);
  if (!subject) throw new Error("nothing opaque in the frame — segmentation removed everything");
  if (specks.length) notes.push(`dropped ${specks.length} speck(s) under 1% of the subject`);

  const keep: Blob[] = opts.keepExtras === false ? [subject] : [subject, ...extras];
  if (extras.length && opts.keepExtras !== false) {
    notes.push(
      `kept ${extras.length} detached piece(s) — registration is by bounding box, so a detached piece moves the centre`,
    );
  }
  let box = unionBox(keep)!;

  if (opts.stripShelf) {
    const stripped = stripGroundShelf(src, box);
    if (stripped) {
      box = stripped;
      notes.push("stripped a ground shelf from the bottom band");
    }
  }

  const cut = crop(src, box);
  const k = Math.min((targetH * size) / cut.height, (SUBJECT_W_MAX * size) / cut.width);
  const dw = Math.max(1, Math.round(cut.width * k));
  const dh = Math.max(1, Math.round(cut.height * k));
  const scaled = resampleCell(cut, dw, dh, "box");

  const out = fill(size, size, [255, 255, 255], 0);
  const dx = Math.round((size - dw) / 2);
  const dy = Math.round(feet * size) - dh;
  blit(out, scaled, dx, dy);
  if (dy < 0) notes.push("the figure is taller than the frame at this scale — it was clipped at the top");

  return {
    image: out,
    bbox: [dx, Math.max(0, dy), dx + dw - 1, Math.min(size - 1, dy + dh - 1)],
    feetY: Math.min(size - 1, dy + dh - 1),
    centreX: dx + dw / 2,
    scale: k,
    sourceH: cut.height,
    notes,
  };
}

/**
 * A ground shadow, plinth or 3D contact plane reads as a wide flat band at the
 * bottom of the subject — and `register.ts` plants the LOWEST ink on the floor
 * line, so debris below the feet lifts the whole character off the ground.
 *
 * Same discriminator `prep/prep-sheet.mjs`'s `keyBands` uses: a row the subject
 * only touches across most of its width is not a leg.
 */
export function stripGroundShelf(
  src: RawImage,
  box: [number, number, number, number],
  widthShare = 0.6,
): [number, number, number, number] | null {
  const [x0, y0, x1, y1] = box;
  const bw = x1 - x0 + 1;
  let cut = y1;
  for (let y = y1; y > y0 + (y1 - y0) * 0.9; y--) {
    let opaque = 0;
    for (let x = x0; x <= x1; x++) if (src.data[(y * src.width + x) * 4 + 3] >= 128) opaque++;
    if (opaque / bw >= widthShare) cut = y - 1;
    else break;
  }
  return cut < y1 ? [x0, y0, x1, cut] : null;
}

/**
 * Composite onto the key field: opaque white behind, alpha preserved.
 *
 * Belt AND braces on purpose. `matte.ts` flood-fills from the border and needs
 * a flat opaque field to key; `sliceSheet` cuts on alpha. A frame carrying both
 * survives a diffusion round-trip that drops the alpha channel — which every
 * generation does.
 */
export function flattenOnKey(src: RawImage, rgb: readonly [number, number, number] = [255, 255, 255]): RawImage {
  const n = src.width * src.height;
  const out: RawImage = { width: src.width, height: src.height, data: new Uint8ClampedArray(n * 4) };
  for (let i = 0; i < n; i++) {
    const a = src.data[i * 4 + 3] / 255;
    // RGB composited over the key colour, so a transparent pixel is literally
    // that colour and the matte's border flood-fill has something to key.
    out.data[i * 4] = src.data[i * 4] * a + rgb[0] * (1 - a);
    out.data[i * 4 + 1] = src.data[i * 4 + 1] * a + rgb[1] * (1 - a);
    out.data[i * 4 + 2] = src.data[i * 4 + 2] * a + rgb[2] * (1 - a);
    // Alpha kept, so `sliceSheet` still has a real mask to cut on.
    out.data[i * 4 + 3] = src.data[i * 4 + 3];
  }
  return out;
}
