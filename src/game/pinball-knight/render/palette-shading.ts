/**
 * INDEXED LIGHTING — shadow as a palette ROW WALK, not a multiply.
 *
 * ── THE PROBLEM, MEASURED ──
 *
 * Lighting in this game is continuous (an AO term, a vignette, a ground shadow
 * at 40% alpha) and the frame is then resolved by a nearest-of-32 snap. The 32
 * entries are grouped by MATERIAL IDENTITY — eight families of 3-6 — with steps
 * that are close WITHIN a family and far BETWEEN families. So darkening does not
 * walk a colour down its own ramp. It walks it across the palette.
 *
 * Multiply each entry by 0.95 → 0.05 and record where the snap sends it:
 *
 *   28 leather (THE TAVERN FLOOR)  0.95→23 skin  0.80→27  0.50→26  0.30→1
 *   16 flame                       0.90→25 skin  0.85→15  0.75→24 skin
 *                                  0.55→28 leather  0.40→23 skin  0.35→27
 *   17 flame light                 0.90→21 steel  0.80→25 skin  0.65→20 steel
 *                                  0.60→24 skin  0.50→4 stone  0.45→28 leather
 *   26 leather dark                0.75→1 stone
 *
 * The floor changes HUE at five percent shadow. Every mid-tone oscillates
 * between three or four families on its way down. That is the hard-edged,
 * wrong-coloured blotching under the tavern furniture, and it is why the ordered
 * dither was load-bearing: it was hiding this. Halving the dither amplitude on
 * 2026-07-30 (to stop sprites wearing confetti) took the cover away and exposed
 * the mechanism underneath.
 *
 * ── THE FIX ──
 *
 * Snap ONCE to an index, then walk N rows down that index's own ramp. A shadowed
 * brown floor stays brown by construction, because the walk cannot leave the
 * family — this is the SNES/RO palette-row model, and it is the same mechanism
 * as a dye swap (which is why a tint and a shadow end up being one piece of
 * code).
 *
 * The tables are hand-authored rather than derived by "nearest darker entry",
 * because nearest-darker is the very metric that produces the table above.
 *
 * ── WIRED, AND THE ONE THING THAT MUST STAY TRUE ─────────────────────────────
 *
 * Live since `51bbd77`: `engine/render/pixel-pass.ts` bakes these tables into a
 * PALETTE_SIZE x (rows+1) shaded-palette texture in `buildShadedPalette`, and
 * the quantizer's unrolled min-reduction carries the winning INDEX so lighting
 * can be spent as a row walk. `shadeDown` is injected through `PaletteSource`
 * rather than imported, because `engine/` may not depend on game content and a
 * colour ramp is art direction.
 *
 * ⚠️ **THE PASS ONLY GETS THIS TABLE IF THE BOOT PATH HANDS IT OVER, AND FOR A
 * DAY IT DID NOT.** `setEnginePalette` treats `shadeDown` as optional and falls
 * back to `i → i-1` — right for the neutral greyscale default, catastrophic
 * here. `installEngine()` built its own PaletteSource literal, omitted the
 * field, and every shipped session shaded across families: rot masonry greyed
 * out, arcane blue shaded to leather brown, blood never darkened at all. The
 * Cold Crypt hid it for a day because stone is entries 0-5 in descending order,
 * so `i-1` IS the stone ramp — and stone was the biome that got screenshotted.
 * There is now ONE installer (`installPalette`) and a test that the boot path
 * calls it: `render/palette-install.test.ts`. Do not add a second literal.
 *
 * ── TWO DEFECTS FROM THE FIRST ATTEMPT, KEPT BECAUSE THEY STILL CONSTRAIN ────
 *
 * 1. **Dithering the shade ROW is not the free win it looks like.** A Bayer
 *    nudge on the row index can only move a pixel along its own ramp, so the
 *    amplitude could in principle go back up without confetti. True, and
 *    irrelevant: one ROW is an enormous step (stone light → stone mid) next to
 *    a 1/32 colour nudge, and `floor(shade*rows + b + 0.5)` flips roughly a
 *    third of a FLAT region a whole row — heavy speckle. The shipped pass
 *    therefore dithers the TARGET LUMA, a sub-row quantity. If the row walk is
 *    ever dithered directly, that is the constraint it has to respect.
 *
 * 2. **Removing the multiplies loses the scene's grading, and a linear
 *    shade→row map does not replace it.** With AO and vignette spent as at most
 *    six discrete rows, most of the frame lands on row 0 and renders unshaded:
 *    the dungeon went bright grey-brown. The shipped pass picks the row by
 *    MATCHING LUMA against what the old multiply would have produced, which is
 *    self-calibrating and has no constant to tune. Do not "simplify" it back
 *    into a scale.
 *
 * Screenshot every iteration on a real adapter; the suite cannot see any of this.
 */

/**
 * Family spans, light → dark, as they are laid out in `palette.ts`.
 *
 * Stone is listed 5→0 and therefore ends at void; every other family ends at its
 * own darkest entry and then falls through to ink. See `SHADE_DOWN`.
 */
export const FAMILIES: readonly (readonly number[])[] = [
  [5, 4, 3, 2, 1, 0], // stone / void — 1 is ink, 0 is void
  [9, 8, 7, 6],       // rot green
  [13, 12, 11, 10],   // blood
  [18, 17, 16, 15, 14], // torch
  [22, 21, 20, 19],   // steel
  [25, 24, 23],       // skin
  [28, 27, 26],       // leather / wood
  [31, 30, 29],       // arcane
];

/** Family index for a palette entry, for tests and reporting. */
export function familyOf(idx: number): number {
  for (let f = 0; f < FAMILIES.length; f++) if (FAMILIES[f].includes(idx)) return f;
  return -1;
}

/**
 * Entry count, derived from FAMILIES rather than imported from `palette.ts`.
 *
 * Not a style choice: `palette.ts` installs these tables, so importing back the
 * other way is a cycle. FAMILIES is the right source anyway — a palette entry
 * that belongs to no ramp cannot be shaded, and the partition test upstream
 * asserts the two agree.
 */
export const PALETTE_N = FAMILIES.reduce((n, f) => n + f.length, 0);

/**
 * One step DARKER, staying inside the entry's own family.
 *
 * A family's darkest entry falls through to ink (1), and ink falls through to
 * void (0), which is a fixed point. That terminator matters: deep shadow must
 * actually reach black, and it must STOP there. A walk that cycles, or that
 * clamps one step short of black, shows up as a shadow that never gets dark
 * enough and then bands anyway at the bottom.
 */
export const SHADE_DOWN: Uint8Array = (() => {
  const t = new Uint8Array(PALETTE_N);
  for (const fam of FAMILIES) {
    for (let i = 0; i < fam.length; i++) {
      t[fam[i]] = i + 1 < fam.length ? fam[i + 1] : 1; // last → ink
    }
  }
  t[1] = 0; // ink → void
  t[0] = 0; // void is the fixed point
  return t;
})();

/**
 * One step LIGHTER, staying inside the family. The inverse of `SHADE_DOWN`
 * within a ramp; the family's lightest entry is a fixed point (there is nothing
 * brighter to offer, and inventing one is how a highlight blooms).
 */
export const SHADE_UP: Uint8Array = (() => {
  const t = new Uint8Array(PALETTE_N);
  for (let i = 0; i < PALETTE_N; i++) t[i] = i;
  for (const fam of FAMILIES) {
    for (let i = 1; i < fam.length; i++) t[fam[i]] = fam[i - 1];
  }
  // Ink and void belong to the stone ramp going down, but brightening them back
  // up through stone would turn every outline into masonry under a torch.
  t[0] = 0;
  t[1] = 1;
  return t;
})();

/** Walk `n` rows down (n < 0 walks up). Saturates at the ramp ends. */
export function shadeBy(idx: number, n: number): number {
  let v = idx;
  for (let k = 0; k < Math.abs(n); k++) v = n > 0 ? SHADE_DOWN[v] : SHADE_UP[v];
  return v;
}

/**
 * The tables flattened for the GPU, as `steps + 1` rows of `PALETTE_N` entries:
 * `row[s * PALETTE_N + i]` is entry `i` shaded by `s`.
 *
 * The pixel pass has no uniform array indexing (its palette is a compile-time
 * constant and the snap is an unrolled min-reduction), so the shader unrolls a
 * select over this table. Building it here keeps the arithmetic testable in
 * plain node instead of only observable through a rendered frame.
 */
export function shadeTable(steps: number): Uint8Array {
  const t = new Uint8Array((steps + 1) * PALETTE_N);
  for (let i = 0; i < PALETTE_N; i++) t[i] = i;
  for (let s = 1; s <= steps; s++) {
    for (let i = 0; i < PALETTE_N; i++) t[s * PALETTE_N + i] = SHADE_DOWN[t[(s - 1) * PALETTE_N + i]];
  }
  return t;
}
