/**
 * NAMING — sheet file → creature + facing, and rows → clip labels.
 *
 * Pure string work, extracted from `sprite-ingest.test.ts` so the browser
 * refiner names frames exactly the way the headless run does.
 */
import type { ClipName, Dir } from "../../engine/render/paint-types";

/** The clip table the animator packs, and the frame counts the roster ships. */
export const CLIPS: [ClipName, number][] = [["idle", 2], ["walk", 4], ["attack", 3], ["death", 4]];

/**
 * Clip names the animator actually packs. Anything else is reported, not used.
 *
 * ⚠️ TYPED AS `ClipName[]`, NOT `string[]`, DELIBERATELY. This used to be a bare
 * `Set<string>` — a hand-mirror of the `ClipName` union that tsc could not
 * check, so a sheet labelled `hurt` (the obvious name, and the one every
 * reference sheet prints above that row) sailed through as "unknown clip,
 * reported not fatal" and produced an actor missing its stagger. The engine's
 * name for that clip is `stumble`. With this typing, writing `hurt` here is a
 * compile error instead of a runtime shrug.
 */
export const KNOWN_CLIPS: ReadonlySet<ClipName> = new Set<ClipName>([
  // Kept in step with `PLAYABLE` in render/imported-paints.ts — the runtime's
  // list of what an imported sheet may name. `ball` was missing here while the
  // runtime accepted it, so a legitimate player-art row was reported as an
  // unknown clip and then worked anyway; a forge that cries wolf about a row
  // the game happily plays is worse than one that says nothing.
  "idle", "walk", "attack", "death", "run", "crouch", "wait", "wake", "stumble", "roll", "ball",
]);

/** `ratking-E.png` → { name: "ratking", dir: "E" }. */
export function parseName(file: string): { name: string; dir: Dir } {
  const base = file.replace(/\.png$/i, "");
  const m = /^(.*)-([SNE])$/.exec(base);
  return m ? { name: m[1], dir: m[2] as Dir } : { name: base, dir: "E" };
}

/**
 * Frame labels for a flat count, from the roster's clip table when it matches.
 *
 * A mismatch is not an error — it means this sheet is not laid out like the
 * painted roster, which is the normal case for an imported sheet. The frames
 * get positional names and the row→clip mapping comes from the recipe instead.
 */
export function labelsFor(count: number): string[] {
  const named = CLIPS.flatMap(([clip, n]) => Array.from({ length: n }, (_, i) => `${clip}${i}`));
  return count === named.length ? named : Array.from({ length: count }, (_, i) => `f${String(i).padStart(2, "0")}`);
}

/**
 * Row clip names → per-cell labels, e.g. row `idle` with 3 cells → idle0/1/2.
 *
 * Numbered per CLIP rather than per row, because a clip too long for one row is
 * authored as two (`["attack", "attack"]`) and `importedPaints` concatenates
 * them. Restarting at 0 on the second row made both rows write the same
 * `<dir>-attack0..3.png` filenames, so the review directory showed four frames
 * where the sheet has eight and the duplicate rows looked like a mistake.
 */
export function labelRows(rowCellCounts: readonly number[], rowNames?: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Map<string, number>();
  rowCellCounts.forEach((n, ri) => {
    const clip = rowNames?.[ri] ?? `row${ri}`;
    let next = seen.get(clip) ?? 0;
    for (let ci = 0; ci < n; ci++) out.push(`${clip}${next++}`);
    seen.set(clip, next);
  });
  return out;
}

/** Clip names in a recipe that the animator will not pack. Reported, never fatal. */
export function unknownClips(rowNames: readonly string[] | undefined): string[] {
  return rowNames?.filter((c) => !KNOWN_CLIPS.has(c as ClipName)) ?? [];
}
