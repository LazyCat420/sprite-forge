/**
 * Dungeon — "Cold Crypt" palette.
 *
 * 32 colours, hand-picked. The warm hues are confined to the torch ramp
 * (14-18), skin (23-25) and leather/wood (26-28) — the environment itself is
 * cold stone, rot, steel and blood.
 * That's deliberate: it makes torchlight feel like the only comfort down here,
 * and it contrasts hard with the mouse room's warm earth palette (`P` in
 * mouse-room.ts) so descending feels like going somewhere else.
 *
 * These are raw sRGB values (NOT THREE.Color — we must not let three.js
 * colour-manage them into linear space, since the quantize shader compares
 * against them in sRGB).
 *
 * Sprite art references these by index via paletteCss() in cel-painter.ts.
 *
 * ── THE CENSUS (2026-07-28) ──────────────────────────────────────────────────
 *
 * Two measurements, because they disagree and the disagreement is the point.
 *
 * **Static**: 435 index-literal references across 17 non-test modules
 * (`paletteCss(n)`, figure's `C(n)`, cel-painter's `F/SH/HI(n)`, `PALETTE_HEX[n]`).
 * Exactly ONE entry has zero of them: **5, stone highlight**.
 *
 * **Pixel**: every actor/item/npc/prop painter run over its full clip table,
 * 1.94M opaque painted pixels snapped to this palette by the same luma-weighted
 * nearest match `crushToGrid` uses.
 *
 *   idx  share   who
 *    1  25.58%   ink — a QUARTER of every actor is outline
 *    6   6.95%   rot shadow (boss/brute/spitter)
 *    3   6.45%   stone mid (knight, golem)
 *   20   6.06%   steel mid (knight 68%)
 *    7   5.48%   rot dark
 *   19   4.86%   steel dark
 *   10   4.20%   blood shadow (reaper 74%)
 *   21   4.14%   steel light
 *    2   3.84%   stone dark
 *    5   3.55%   stone highlight ← NOTHING NAMES IT
 *   ...
 *   18   0.047%  flame core     ┐ the torch ramp is 2.26% of all actor pixels.
 *   14   0.055%  ember          ┘ "the only warmth down here" barely touches a body.
 *
 * Two findings drove work in this wave:
 *
 * 1. **Entry 5 is not dead.** The static census says it is — no module names it
 *    — and deleting it on that evidence would have been wrong: the quantizer
 *    routes 3.55% of all painted pixels onto it anyway (49% of those from the
 *    ghost, 30% from the knight's plate). A palette entry has TWO ways to be
 *    reached and only one of them greps. It is now also named, as the bounce
 *    tone for dark steel and stone (see RIM_FOR below).
 *
 * 2. **The warm ramp is decorative, not structural.** 14-18 together take 2.26%
 *    of actor pixels and almost all of that is a goblin's lantern and a few
 *    glow dots. Actors were lit entirely out of their OWN ramp, which is why a
 *    rot-green zombie standing on a painted flowstone patch has no edge at all.
 *    The rim/bounce tone below spends the torch ramp where it separates a
 *    silhouette from the floor.
 */

import { clamp } from "../../../utils/math";
import { setEnginePalette } from "../engine/palette-source";
import { SHADE_DOWN, SHADE_UP } from "./palette-shading";

export const PALETTE_HEX: number[] = [
  // ── Stone / void (0-5) ──
  0x0b0d12, // 0  void black
  0x171a22, // 1  outline
  0x2b303b, // 2  stone dark
  0x454f5e, // 3  stone mid
  0x6b7688, // 4  stone light
  0x9aa4b4, // 5  stone highlight

  // ── Rot green (6-9) ──
  0x1e2f1f, // 6  rot shadow
  0x3d5c3a, // 7  rot dark
  0x5f8a4f, // 8  rot mid
  0x8fc46b, // 9  rot light

  // ── Blood (10-13) ──
  0x3a0f18, // 10 blood shadow
  0x6b1f2a, // 11 blood dark
  0xa83244, // 12 blood mid
  0xd95763, // 13 blood light

  // ── Torch (14-18) — the only warmth ──
  0x7a3b12, // 14 ember
  0xd97b29, // 15 flame dark
  0xf0a63c, // 16 flame
  0xffd98a, // 17 flame light
  0xfff3c8, // 18 flame core

  // ── Steel (19-22) ──
  // Metal ramp rule (deep-research 2026-07-15): the DARK end of a metal ramp
  // leans WARMER and more saturated while the light end stays cold/desaturated —
  // that opposite-temperature spread is what reads as steel instead of plastic.
  // 19 carries a violet warmth; 21/22 stay icy.
  0x544e63, // 19 steel dark (warm violet-slate)
  0x8a94a6, // 20 steel mid
  0xc8ccd4, // 21 steel light
  0xeef1f5, // 22 steel highlight

  // ── Skin (23-25) ──
  0x6b4436, // 23 skin shadow
  0xa9705a, // 24 skin mid
  0xd69f7e, // 25 skin light

  // ── Leather / wood (26-28) ──
  0x2a1c14, // 26 leather shadow
  0x4a3222, // 27 leather dark
  0x6b4a2e, // 28 leather mid

  // ── Cold accent / arcane (29-31) ──
  0x1f3d52, // 29 arcane dark
  0x2e6d8f, // 30 arcane mid
  0x6fd0e8, // 31 arcane light
];

export const PALETTE_SIZE = PALETTE_HEX.length; // 32

/**
 * The ramp families, by the index ranges documented above. This is sidecar
 * vocabulary: a sprite-forge sidecar can declare `"bans": ["rot"]` to keep a
 * creature's materials out of a family the luma-weighted snap would otherwise
 * reach (measured on the knight: ~12% of crushed armor texels landed on rot
 * because the metric discounts blue — see commit.ts `CommitOptions.ban`).
 * Void/ink are not listed: no sheet may ban the outline.
 */
export const PALETTE_FAMILIES: Readonly<Record<string, readonly number[]>> = {
  stone: [2, 3, 4, 5],
  rot: [6, 7, 8, 9],
  blood: [10, 11, 12, 13],
  torch: [14, 15, 16, 17, 18],
  steel: [19, 20, 21, 22],
  skin: [23, 24, 25],
  leather: [26, 27, 28],
  arcane: [29, 30, 31],
};

/** Flat Float32Array of sRGB triplets, for the quantize shader uniform. */
export function paletteToFloatArray(): Float32Array {
  const out = new Float32Array(PALETTE_SIZE * 3);
  for (let i = 0; i < PALETTE_SIZE; i++) {
    const hex = PALETTE_HEX[i];
    out[i * 3 + 0] = ((hex >> 16) & 0xff) / 255;
    out[i * 3 + 1] = ((hex >> 8) & 0xff) / 255;
    out[i * 3 + 2] = (hex & 0xff) / 255;
  }
  return out;
}

/** `#rrggbb` for canvas 2D fillStyle (used when painting sprite atlases). */
export function paletteCss(index: number): string {
  return `#${PALETTE_HEX[index].toString(16).padStart(6, "0")}`;
}

// ── Colour ramps: the whole point of "selout" and hue-shifted shading ──
//
// Pixel artists don't outline in pure black and don't darken by adding black.
// A limb reads as sculpted when its OUTLINE is a darker, hue-shifted version of
// its own fill (selout) and its SHADE leans cool while its HIGHLIGHT leans warm
// (hue shifting). We can't hand-place pixels — the knight is vector art crushed
// to 36px — but we CAN pick these colours per-shape at paint time, and the 32-
// colour quantizer then snaps everything back onto the Cold-Crypt ramps.

/** Split a palette entry into 0-255 sRGB channels. */
function rgb(index: number): [number, number, number] {
  const hex = PALETTE_HEX[index];
  return [(hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff];
}

function css([r, g, b]: [number, number, number]): string {
  const h = (v: number) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/**
 * The "ink" for a given fill: a darker, cool-shifted version of the fill
 * colour rather than pure black. Blue/red channels are pulled down hardest and
 * a touch of cold blue is mixed in, so a steel outline goes cool-grey, a
 * leather outline goes cold-brown — the selout look. `strength` 0..1 = how far
 * toward the outline it goes (1 ≈ old pure-ish ink weight, but tinted).
 */
export function inkFor(fillIndex: number, strength = 1): string {
  const [r, g, b] = rgb(fillIndex);
  const k = 0.34 + 0.16 * (1 - strength); // darker for stronger outlines
  // cool bias: shove toward the void-blue, not toward black
  const [vr, vg, vb] = rgb(0); // void black 0b0d12 — carries a faint blue
  return css([r * k + vr * 0.28, g * k + vg * 0.28, b * k * 0.9 + vb * 0.4]);
}

/**
 * A hue-shifted highlight for a fill: brighter AND warmer (toward torch light),
 * because in this room the only light with any warmth is fire. Used for the lit
 * side of a material so metal doesn't just go white.
 */
export function highlightFor(fillIndex: number, amt = 0.5): string {
  const [r, g, b] = rgb(fillIndex);
  const warm = [255, 236, 180]; // toward flame-light 17/18
  return css([r + (warm[0] - r) * amt, g + (warm[1] - g) * amt * 0.9, b + (warm[2] - b) * amt * 0.7]);
}

/**
 * A hue-shifted shade for a fill: darker AND cooler (toward arcane blue), the
 * standard "shadows lean toward the complementary cool" trick.
 */
export function shadeFor(fillIndex: number, amt = 0.5): string {
  const [r, g, b] = rgb(fillIndex);
  const cool = [31, 61, 82]; // toward arcane-dark 29
  return css([r + (cool[0] - r) * amt - 12, g + (cool[1] - g) * amt - 8, b + (cool[2] - b) * amt]);
}

/**
 * Install this palette into the engine's palette slot.
 *
 * WHY THIS EXISTS. `engine/render/figure.ts` — which paints every limb, plate
 * and head of every actor — reads its colours through `enginePalette`, and that
 * source DEFAULTS TO A 16-STEP GREYSCALE until something installs the real one.
 * `GameEngine` does it at dungeon boot, so anything that paints a sprite
 * WITHOUT booting the dungeon gets a greyscale figure and no error: the card
 * portraits render as grey robots rather than rotted green corpses, and nothing
 * anywhere reports a problem.
 *
 * That is not hypothetical. It cost a full debugging pass — a sprite was
 * declared broken and nearly rewritten — before the cause turned out to be a
 * render harness that had simply never installed the palette. The card surfaces
 * are one cold-start away from the same bug in the shipped game.
 *
 * Idempotent and cheap, so any surface that paints a sprite can just call it.
 */
export function installPalette(): void {
  setEnginePalette({
    size: PALETTE_SIZE,
    toFloatArray: paletteToFloatArray,
    hex: () => PALETTE_HEX,
    css: paletteCss,
    // Arcane mid — the tone an actor is silhouetted in behind a wall.
    occlusionIndex: 30,
    // How this palette darkens. Without it the pixel pass falls back to `i-1`,
    // which on THIS palette walks straight out of each family into the next
    // (26, leather shadow, would shade to 25, skin light — BRIGHTER, and a
    // different material). See render/palette-shading.ts.
    shadeDown: () => SHADE_DOWN,
    // And how it BRIGHTENS. The pass needs both because the scene's lighting
    // runs from 0.38x to 1.35x of albedo luma (measured — render/light-crossing
    // .ts), so a torch-lit surface has to be able to walk UP its own ramp. The
    // fallback here would be `i+1`, which on this palette leaves the family just
    // as fast as `i-1` did.
    shadeUp: () => SHADE_UP,
  });
}
