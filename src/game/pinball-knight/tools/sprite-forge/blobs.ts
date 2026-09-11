/**
 * CONNECTED COMPONENTS over an alpha channel — one implementation.
 *
 * This flood fill already exists twice in this directory: `matte.ts` walks it
 * to find enclosed background pockets, and `prep/prep-sheet.mjs`'s `dropBleed`
 * walks it to drop slivers that bled in from a neighbouring pose. A third copy
 * for intake would be the `tool-schema-split-build` failure in miniature —
 * copies that pass their own tests and disagree about what the art is. So it
 * lives here and callers ask it questions.
 *
 * ⚠️ PIXELS IN, NOT A FILENAME. Same rule as the rest of this directory: no
 * `canvas`, no `node:fs`. `testkit-boundary.test.ts` scans for exactly those
 * imports because this code sits inside the GAME'S source tree.
 *
 * Four-connected, not eight. An eight-connected labeller welds a character to a
 * prop that merely touches it diagonally, and the whole point of counting
 * components at intake is to notice a second object.
 */

export interface Blob {
  /** Opaque pixel count. */
  area: number;
  /** Inclusive bounds: [x0, y0, x1, y1]. */
  bbox: [number, number, number, number];
  /** Does it touch the canvas edge? A subject that does is probably clipped. */
  touchesEdge: boolean;
}

/** Alpha at or above this counts as ink. Matches the mask threshold intake uses. */
export const OPAQUE_AT = 128;

/**
 * Label every 4-connected opaque region, largest first.
 *
 * Iterative, never recursive: a 1024² silhouette is ~700k pixels and a
 * recursive fill blows the stack on the first real photo.
 */
export function blobs(data: Uint8ClampedArray, w: number, h: number, alphaAt = OPAQUE_AT): Blob[] {
  const seen = new Uint8Array(w * h);
  const out: Blob[] = [];
  const stack: number[] = [];
  const ink = (i: number) => data[i * 4 + 3] >= alphaAt;

  for (let start = 0; start < w * h; start++) {
    if (seen[start] || !ink(start)) continue;
    let area = 0;
    let x0 = w;
    let y0 = h;
    let x1 = -1;
    let y1 = -1;
    let edge = false;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % w;
      const y = (i / w) | 0;
      area++;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge = true;
      if (x > 0 && !seen[i - 1] && ink(i - 1)) (seen[i - 1] = 1), stack.push(i - 1);
      if (x < w - 1 && !seen[i + 1] && ink(i + 1)) (seen[i + 1] = 1), stack.push(i + 1);
      if (y > 0 && !seen[i - w] && ink(i - w)) (seen[i - w] = 1), stack.push(i - w);
      if (y < h - 1 && !seen[i + w] && ink(i + w)) (seen[i + w] = 1), stack.push(i + w);
    }
    out.push({ area, bbox: [x0, y0, x1, y1], touchesEdge: edge });
  }
  return out.sort((a, b) => b.area - a.area);
}

/**
 * The subject, and what was rejected alongside it.
 *
 * `minShare` is measured against the LARGEST blob, not the canvas: a small
 * character in a big frame still has a proportionally large hand.
 *
 * 0.01 rather than `dropBleed`'s 0.0014 because the two are answering
 * different questions. There, a sliver is another pose bleeding into this
 * cell's box and is always garbage. Here, a detached piece could be a
 * dropped weapon or a floating spell — real art, whose removal the operator
 * must SEE rather than have silently deleted. So this returns the rejects
 * instead of dropping them.
 */
export function subjectOf(all: Blob[], minShare = 0.01): { subject: Blob | null; extras: Blob[]; specks: Blob[] } {
  if (!all.length) return { subject: null, extras: [], specks: [] };
  const [subject, ...rest] = all;
  const floor = subject.area * minShare;
  return {
    subject,
    extras: rest.filter((b) => b.area >= floor),
    specks: rest.filter((b) => b.area < floor),
  };
}

/** Union bounds of several blobs — the box a reframe should actually fit. */
export function unionBox(list: Blob[]): [number, number, number, number] | null {
  if (!list.length) return null;
  let [x0, y0, x1, y1] = list[0].bbox;
  for (const b of list.slice(1)) {
    if (b.bbox[0] < x0) x0 = b.bbox[0];
    if (b.bbox[1] < y0) y0 = b.bbox[1];
    if (b.bbox[2] > x1) x1 = b.bbox[2];
    if (b.bbox[3] > y1) y1 = b.bbox[3];
  }
  return [x0, y0, x1, y1];
}
