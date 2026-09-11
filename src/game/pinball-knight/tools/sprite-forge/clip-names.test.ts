/**
 * THREE LISTS OF "WHICH CLIPS EXIST", AND THEY MUST AGREE.
 *
 * The vocabulary is `ClipName` (engine/render/paint-types.ts). Three places
 * enumerate a subset of it, each for a different reason, and none of them can
 * be derived from the others:
 *
 *   KNOWN_CLIPS  labels.ts            what a SIDECAR may name
 *   PLAYABLE     imported-paints.ts   what the importer will pack
 *   CLIP_NAMES   components/forge/    what the PANEL offers, IN ROW ORDER
 *
 * The order in the third is a real affordance — it is the order rows are laid
 * out in the sheet tray — so it cannot become a Set, and a Set cannot become
 * it. What CAN be asserted is that they hold the same members.
 *
 * ── WHY THIS TEST EXISTS ────────────────────────────────────────────────────
 *
 * `CLIP_NAMES` shipped missing `ball`. Ten names against the other two lists'
 * eleven, `as const` on bare strings so nothing checked it. The consequence was
 * silent in the way this repo keeps rediscovering: a `ball` clip could not be
 * selected in the panel, could not reach the tray, and therefore could not
 * reach a sidecar — while the importer and the animator both accepted it
 * perfectly well. No error, no warning, just a clip that was unreachable from
 * the only UI that produces sheets.
 *
 * That is the same defect `labels.ts:13-21` documents for its own list, which
 * used to be a `Set<string>` and let a sheet labelled `hurt` through because
 * the engine's name is `stumble`. The fix there was to type it against the
 * union. This is that fix, applied one stage earlier, plus the assertion that
 * keeps the three from parting company again.
 *
 * Precedent for the shape: `camera-sync.test.ts`, which asserts the two copies
 * of `CAMERA_BY_DIR` agree rather than merging them.
 */
import { describe, it, expect } from "vitest";
import { KNOWN_CLIPS } from "./labels";
import { CLIP_NAMES } from "../../../../../components/forge/types";
import type { ClipName } from "../../engine/render/paint-types";

/**
 * `PLAYABLE` is not exported — it is an implementation detail of
 * `importedPaints`. Read it out of the source rather than exporting it purely
 * for a test, which is the trick `published.test.ts` uses on `IMPORTED_ART`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

function playable(): string[] {
  const src = readFileSync(join(__dirname, "..", "..", "render", "imported-paints.ts"), "utf8");
  const m = /const PLAYABLE[^=]*=\s*new Set<ClipName>\(\[([\s\S]*?)\]\)/.exec(src);
  if (!m) throw new Error("[clip-names] could not find PLAYABLE in render/imported-paints.ts");
  return [...m[1].matchAll(/"(\w+)"/g)].map((x) => x[1]);
}

describe("the three clip lists agree", () => {
  it("the panel offers every clip a sidecar may name", () => {
    const panel = new Set<string>(CLIP_NAMES);
    const missing = [...KNOWN_CLIPS].filter((c) => !panel.has(c));
    expect(
      missing,
      `the forge panel cannot offer ${missing.join(", ")} — a sheet needing that clip ` +
        `cannot be assembled in the UI, silently. Add it to CLIP_NAMES in components/forge/types.ts.`,
    ).toEqual([]);
  });

  it("the panel offers nothing the importer would drop", () => {
    const known = KNOWN_CLIPS as ReadonlySet<string>;
    const extra = CLIP_NAMES.filter((c) => !known.has(c));
    expect(
      extra,
      `the panel offers ${extra.join(", ")}, which labels.ts does not accept — rows tagged ` +
        `with it publish and are then dropped by clipsFor with a console warning nobody reads.`,
    ).toEqual([]);
  });

  it("the importer packs exactly what a sidecar may name", () => {
    // PLAYABLE is what `clipsFor` will actually keep. A name in KNOWN_CLIPS but
    // not here publishes and is dropped at load; the reverse is unreachable.
    expect(new Set(playable())).toEqual(new Set(KNOWN_CLIPS));
  });

  it("every name in all three is a real ClipName", () => {
    // The compiler already proves this for CLIP_NAMES (`satisfies`) and for
    // KNOWN_CLIPS (`Set<ClipName>`). PLAYABLE is read from source as strings,
    // so it is the one that needs a runtime assertion — and it is also the one
    // whose drift is invisible, because a name the animator cannot play is
    // packed into the atlas and simply never drawn.
    const engineNames = new Set<string>(KNOWN_CLIPS as ReadonlySet<string>);
    for (const c of playable()) {
      expect(engineNames.has(c), `PLAYABLE names "${c}", which is not a clip a sidecar may declare`).toBe(true);
    }
    // Belt and braces on the typing above: this line stops compiling if a name
    // is added to CLIP_NAMES that is not in the union.
    const _typed: readonly ClipName[] = CLIP_NAMES;
    expect(_typed.length).toBe(CLIP_NAMES.length);
  });
});
