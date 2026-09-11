/**
 * The palette the pixel pass quantizes to — supplied by the game.
 *
 * The quantize step needs to know the palette SIZE (it picks a dither strength
 * of 2/size) and the colours themselves (uploaded as a uniform array). Both are
 * art direction, not engine policy: "Cold Crypt", 32 colours, is this game's
 * identity. An engine that hardcoded it could not render a different game.
 *
 * So the game registers its palette at boot and the pass reads it from here.
 * The default is a neutral 16-step greyscale — enough for the pass to run
 * standalone (and for a test to construct one without booting the game),
 * obviously not anyone's art direction.
 */

export interface PaletteSource {
  /** Number of entries. The dither strength is derived from this. */
  size: number;
  /** Colours as a flat RGB float array, 3 floats per entry, each 0..1. */
  toFloatArray: () => Float32Array;
  /** Colours as 0xRRGGBB ints — what three.js material `color` wants. */
  hex: () => number[];
  /** `#rrggbb` for canvas 2D fillStyle, used when painting sprite atlases. */
  css: (index: number) => string;
  /**
   * Index of the "occluded actor" tint: the colour a silhouette is drawn in
   * when the player is behind a wall. Named rather than a magic index so the
   * engine does not have to know that this game's arcane mid is entry 30.
   */
  occlusionIndex: number;
  /**
   * One step DARKER for each entry, staying inside that entry's own colour ramp.
   *
   * Supplied by the game because a "ramp" is art direction: the engine cannot
   * know that 26-28 are one wood and 14-18 are one flame. Without it, shading
   * has to be a multiply resolved by a nearest-colour snap — which walks a
   * darkened colour ACROSS families rather than down its own ramp, and is why a
   * shadowed floor used to change hue instead of getting darker.
   *
   * Must terminate: repeated application from any entry has to reach a fixed
   * point (black), or the deepest shadow in the scene is arbitrary.
   *
   * OPTIONAL — defaults to the predecessor chain `i → i-1`, which is correct for
   * a plain greyscale ramp and is all the standalone fallback and the headless
   * art harnesses need, since they never run the pixel pass.
   */
  shadeDown?: () => Uint8Array;
  /**
   * One step LIGHTER for each entry, staying inside that entry's own ramp — the
   * inverse of `shadeDown` within a family, saturating at the family's brightest.
   *
   * ── WHY A DARKENING TABLE IS NOT ENOUGH ──
   * Indexed lighting spends the frame's light as a walk along the material's own
   * ramp, and the light in this game runs BOTH WAYS around unity. Measured over
   * the four biomes and 48 shading situations (`render/light-crossing.ts`), the
   * ratio of lit luma to albedo luma spans 0.38 to 1.35: an open floor renders
   * at under half its own albedo, and a surface next to a torch renders above it.
   *
   * With only a downward table the bright half has nowhere to go. Every
   * torch-lit surface clamps at row 0, the torch stops making anything brighter
   * than the material already was, and the dungeon reads flat — the torches
   * become bloom halos around nothing.
   *
   * OPTIONAL, and its absence is a real degradation rather than a neutral
   * default: without it the pass gets an identity table and lighting above unity
   * is thrown away. The fallback exists so the pass can run standalone, not
   * because it is a reasonable art direction.
   */
  shadeUp?: () => Uint8Array;
}

const FALLBACK_N = 16;

/** Neutral fallback: 16 grey steps. Replaced by the game at boot. */
function greyscaleHex(): number[] {
  return Array.from({ length: FALLBACK_N }, (_, i) => {
    const v = Math.round((i / (FALLBACK_N - 1)) * 255);
    return (v << 16) | (v << 8) | v;
  });
}

function greyscaleFloats(): Float32Array {
  const hex = greyscaleHex();
  const out = new Float32Array(hex.length * 3);
  for (let i = 0; i < hex.length; i++) {
    out[i * 3] = ((hex[i] >> 16) & 0xff) / 255;
    out[i * 3 + 1] = ((hex[i] >> 8) & 0xff) / 255;
    out[i * 3 + 2] = (hex[i] & 0xff) / 255;
  }
  return out;
}

/** Fallback shading: one step down the ramp, saturating at black (a fixed point). */
function descendingChain(n: number): Uint8Array {
  const t = new Uint8Array(n);
  for (let i = 0; i < n; i++) t[i] = Math.max(0, i - 1);
  return t;
}

/** Fallback brightening: one step up the greyscale ramp, saturating at white. */
function ascendingChain(n: number): Uint8Array {
  const t = new Uint8Array(n);
  for (let i = 0; i < n; i++) t[i] = Math.min(n - 1, i + 1);
  return t;
}

/**
 * Live palette. Mutated in place rather than reassigned so modules that read it
 * at construction see whatever the game installed.
 */
export const enginePalette: PaletteSource = {
  size: FALLBACK_N,
  toFloatArray: greyscaleFloats,
  hex: greyscaleHex,
  css: (i) => `#${(greyscaleHex()[i] ?? 0).toString(16).padStart(6, "0")}`,
  occlusionIndex: FALLBACK_N - 1,
  shadeDown: () => descendingChain(FALLBACK_N),
  shadeUp: () => ascendingChain(FALLBACK_N),
};

/** Install the game's palette. Call before the pixel pass is created. */
export function setEnginePalette(src: PaletteSource): void {
  enginePalette.size = src.size;
  enginePalette.toFloatArray = src.toFloatArray;
  enginePalette.hex = src.hex;
  enginePalette.css = src.css;
  enginePalette.occlusionIndex = src.occlusionIndex;
  // Sized to the palette being installed — a stale table from a smaller palette
  // would index past its end and shade everything it could not find to black.
  enginePalette.shadeDown = src.shadeDown ?? (() => descendingChain(src.size));
  enginePalette.shadeUp = src.shadeUp ?? (() => ascendingChain(src.size));
}
