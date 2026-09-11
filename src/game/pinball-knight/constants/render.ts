/**
 * Render pipeline, camera, sprites, lighting, atmosphere and animation timing.
 *
 * Split out of the 2522-line constants.ts so parallel tracks stop colliding on
 * one file. Consumers still import from `../constants` — that barrel re-exports
 * every module here, so no call site changed.
 */
// ── Render pipeline ─────────────────────────────────────────────
/**
 * The REFERENCE render resolution — the FLOOR, not a fixed size.
 *
 * 1280×720 is the CEL-SHADED round (2026-07-14 playtest: "make the sprites
 * cel shaded instead of this pixel look"): actors are vector-drawn cels (see
 * render/cel-painter.ts) crushed to a hard pixel grid, with the palette
 * quantizer + depth-edge ink outline on top.
 *
 * WHAT CHANGED (2026-07-19). These used to be the LITERAL size of the render
 * target, at every window size, with a FRACTIONAL upscale on top (see
 * INTEGER_SCALE below, now deleted). That was the single biggest source of
 * mush in the whole game: on a 1920×1080 window the upscale was ×1.5, so under
 * `image-rendering: pixelated` every render pixel became alternately 1 or 2
 * screen pixels — an irregular comb across the ENTIRE frame, every sprite,
 * prop and tile at once. The old comment justified it with "cel art scales
 * cleanly (it's smooth shapes, not a pixel grid)"; that premise died when the
 * pipeline started crushing everything to a pixel grid.
 *
 * Now `computeRenderSizing()` in render/pixel-pass.ts DERIVES the render
 * target from the window each resize so the upscale is always a whole number
 * AND the image still fills the screen: it picks the integer zoom from THIS
 * reference, then grows the target to cover the window. So the player never
 * sees LESS than 1280×720 worth of level — but on a window that isn't an exact
 * multiple they do see somewhat MORE (a 1920×1080 window renders 1920×1080 at
 * ×1, i.e. 30×16.875 tiles instead of 20×11.25). That is the deliberate price
 * of "integer scale AND no letterbox AND fixed PPU" — you cannot have all
 * three plus a constant field of view.
 */
export const RENDER_W = 1280;
export const RENDER_H = 720;

/**
 * Ceiling on the derived render target. This is a FIELD-OF-VIEW clamp first and
 * an allocation guard second.
 *
 * Integer scale, a full-screen fill, and a fixed field of view are mutually
 * exclusive — you can have any two. We gave up fixed FOV (see the RENDER_W note
 * above), but unbounded that trade is worse than it sounds: PPU is pinned at
 * 64, so the render width IS the field of view. A 1920-wide target shows 30
 * tiles where the game was designed around 20, which makes every sprite
 * physically SMALLER on screen — the opposite of the fidelity this whole change
 * was chasing, even though each pixel is now perfectly square.
 *
 * 1920×1080 is chosen so the most common desktop size fills the screen at a
 * whole-number scale. The previous 1600×900 was a bad pick: it sat just below
 * 1920, so a 1080p player got 160px bars each side and 90px top and bottom —
 * 31% of the screen black — to buy a framing nobody asked for.
 *
 * Be clear about what integer scaling costs at 1080p, because it is real and
 * there is no way to avoid it: the old fractional path was effectively ×1.5,
 * giving the designed 20 tiles at 96px each. No integer reproduces that. ×1 is
 * 30 tiles at 64px (more level, smaller figures); ×2 is 15 tiles at 128px (big
 * chunky figures, a quarter less warning of what is coming). We took ×1.
 *
 * Past this size the integer scale is KEPT and the canvas letterboxes: crispness is the thing we refuse to
 * trade, and modest bars beat a level that silently zooms out on a big monitor.
 * It also still does the original job — a 7680×1080 ultrawide pins the scale at
 * 1 and would otherwise ask for a 7680-wide target.
 *
 * Raising this re-opens the FOV question; it is not a free "use more of the
 * screen" dial. Must stay EVEN (see the even-size rule in pixel-pass.ts).
 */
export const MAX_RENDER_W = 2160;
export const MAX_RENDER_H = 1216;

/**
 * Pixels per world unit. FIXED at 72 — one tile (1 world unit) is always
 * exactly 72 render pixels, at every window size.
 *
 * This is load-bearing and must NOT be made adaptive: sprite crispness depends
 * on `SPRITE_UNITS * PPU === SPRITE_PIXEL_GRID` (asserted in
 * render/sprite-scale.test.ts), which is what maps one stored art pixel onto
 * one render pixel. The ortho frustum is what flexes with the window instead —
 * pixel-pass.ts resizes it to renderW/PPU × renderH/PPU on every resize.
 *
 * ── WHY 96 AND NOT 64 (2026-07-29, "the faces look blurry") ─────────────────
 * PPU is the FIDELITY dial, and 64 was spending the window on field of view
 * instead of on detail. At 64 a 1920-wide target showed 30 tiles and an actor
 * was 72 render pixels tall — which sounds fine until you count what a FACE
 * gets out of that: a head about 20 texels across, so an eye is two, a brow is
 * one, and a whisker is none. Sub-texel features do not become pixels; they
 * tint their host texel by a fraction, which the palette snap then rounds to
 * some arbitrary neighbour. That is what "blurry" was — not a soft filter
 * (filtering has been NEAREST throughout) but detail authored below the grid
 * and quantized into confetti.
 *
 * Raising PPU to 80 raises SPRITE_PIXEL_GRID to 90 with it (the identity
 * above), so an actor is drawn with 1.56x the texels and a face has room for
 * actual features. Three things make this cheap:
 *
 *   · SPRITE_UNITS is unchanged at 1.125, so the world is untouched. Colliders,
 *     reach, spacing and every tuned distance mean exactly what they did.
 *   · The render target does not grow — renderW/renderH still come from the
 *     window. The frustum SHRINKS instead (20 tiles across at 1920 rather than
 *     24), so per-frame GPU cost is identical. This buys detail with atlas
 *     memory and boot paint, not with framerate.
 *   · The camera barely tightens: 26.7 tiles across at 1920 rather than 30.
 *
 * PPU IS THE ZOOM as much as it is the fidelity dial, and at a fixed window
 * size the two TRADE DIRECTLY — tiles-on-screen x pixels-per-actor is a
 * constant budget. That is the real constraint on this number and it cannot be
 * engineered away; it can only be spent. Playtested down the ladder:
 *
 *     PPU   grid   tiles@1920   texel area vs the 72-grid
 *      96    108         20.0   2.25x   — too close to read the map from
 *      80     90         24.0   1.56x   — still too close
 *      72     81         26.7   1.27x   — was here
 *      64     72         30.0   1.00x   — HERE. 12.5% more level on screen.
 *
 * MOVED 72 → 64 on request: the camera sat too close. Read the trade honestly —
 * this is not a free zoom-out, it is 12.5% of the texels on every actor, and
 * the note above about 64 being "the blurry one" was written about a pipeline
 * that ALSO crushed to 52 and nearest-upscaled back. That part is gone; what is
 * left at 64 is one clean resample to a 72-texel cell, which is still the
 * resolution the paragraph under SPRITE_PIXEL_GRID calls the point where
 * characters "stop looking low-res".
 *
 * WHY NOT EXACTLY 15%. PPU is the denominator of SPRITE_UNITS, and
 * SPRITE_PIXEL_GRID = SPRITE_UNITS × PPU has to be a whole number of texels or
 * every sprite samples between texels — the uneven-pixel mush the whole
 * pipeline exists to avoid, and what `render/sprite-scale.test.ts` guards. With
 * SPRITE_UNITS held at 9/8 that makes PPU a multiple of 8, so the ladder is
 * 72 → 64 (+12.5%) or 72 → 56 (+28.6%). 72 × 0.85 = 61.2 is not on it. 64 is
 * the nearest rung to the 15% asked for, and the only one that keeps the level
 * readable.
 *
 * An ODD grid (81) is fine: the evenness requirement in pixel-pass.ts is on
 * renderW/renderH, so that the ortho frustum's centre lands on a whole texel.
 * Nothing requires the ATLAS CELL to be even.
 *
 * The cost is real and it is paid at BOOT: 1.56x the texels per atlas cell, and
 * a larger supersample buffer to feed them. Measured in LOAD_PERF_PLAN terms,
 * that is where to look if boot regresses.
 */
/**
 * ── THE CAMERA ZOOM LADDER, AND WHY IT HAS RUNGS ──
 *
 * PPU is the zoom, and it is also the denominator of `SPRITE_UNITS`. Since
 * `SPRITE_PIXEL_GRID = SPRITE_UNITS x PPU` has to be a whole number of texels —
 * or every sprite samples between texels, which is the mush this whole pipeline
 * exists to prevent — and `SPRITE_UNITS` is 3/2, PPU must be EVEN.
 * There is no continuous zoom slider available here; there are rungs.
 *
 *     setting   PPU   grid   tiles @1712   vs NORMAL
 *     close      80    120      21.4       -11%  (the old pre-2026-07 framing)
 *     normal     72    108      23.8         —
 *     wide       64     96      26.8       +12.5%
 *     wider      56     84      30.6       +28.6%   ← default
 *     widest     48     72      35.7       +50%
 *
 * The right-hand column is the price: grid is texels per actor, and it falls
 * with the zoom because the actor is physically smaller on screen. `widest` at
 * 54 is the resolution the note under SPRITE_PIXEL_GRID calls "the awkward
 * middle" — it is offered because a player fighting at speed may want the
 * field of view more than the faces, but it is not the default.
 *
 * DEFAULT IS `wider`. Playtested at speed: at `normal` the knight outruns what
 * is on screen, which is a control problem rather than a taste one — you cannot
 * steer around a wall you cannot see yet.
 */
export type CameraZoom = "close" | "normal" | "wide" | "wider" | "widest";

export const CAMERA_ZOOMS: Record<CameraZoom, number> = {
  close: 80,
  normal: 72,
  wide: 64,
  wider: 56,
  widest: 48,
};

/** Display order for the settings cycler — closest first. */
export const CAMERA_ZOOM_ORDER: CameraZoom[] = ["close", "normal", "wide", "wider", "widest"];

export const CAMERA_ZOOM_DEFAULT: CameraZoom = "wider";

/**
 * The settings blob's storage key.
 *
 * Declared HERE rather than in `settings-save.ts`, which is the module that
 * owns settings, because the dependency has to run the other way: `PPU` is a
 * module-level const that half the engine captures at import time, so it must
 * resolve before anything else loads — and `settings-save.ts` already imports
 * this file for the render defaults. Two copies of a storage key is how a
 * setting silently stops being read.
 */
export const SETTINGS_KEY = "pinball-knight-settings";

/**
 * The saved zoom, read straight from storage at module load.
 *
 * ── WHY THIS CANNOT BE LIVE ──
 * `PPU` is destructured into module-level aliases all over the engine
 * (`pixel-pass.ts` does it at line ~100), and `SPRITE_PIXEL_GRID` sizes the
 * sprite ATLAS, which is rasterised once at boot. Changing either after load
 * would leave the frustum and the atlas disagreeing about how big a texel is.
 * So the setting is resolved exactly once, here, before any of that runs, and
 * the settings screen tells the player it applies on reload rather than lying
 * with a control that half-works.
 */
function savedCameraZoom(): CameraZoom {
  if (typeof localStorage === "undefined") return CAMERA_ZOOM_DEFAULT;
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return CAMERA_ZOOM_DEFAULT;
    const parsed = JSON.parse(raw) as { cameraZoom?: unknown };
    const z = parsed.cameraZoom;
    return typeof z === "string" && z in CAMERA_ZOOMS ? (z as CameraZoom) : CAMERA_ZOOM_DEFAULT;
  } catch {
    // Blocked storage, private mode, a hand-edited blob: fall back rather than
    // take the whole render pipeline down over a preference.
    return CAMERA_ZOOM_DEFAULT;
  }
}

export const CAMERA_ZOOM: CameraZoom = savedCameraZoom();
export const PPU = CAMERA_ZOOMS[CAMERA_ZOOM];

/**
 * The REFERENCE view, in tiles — the frustum the camera is BORN with. The live
 * frustum is re-derived from the current render size by pixel-pass.ts, so
 * treat these as the floor (20×11.25 tiles), not as the running value.
 */
export const VIEW_W = RENDER_W / PPU; // 20 tiles across at the 1280 reference
export const VIEW_H = RENDER_H / PPU; // 11.25 tiles down

// ── Camera ──────────────────────────────────────────────────────
/**
 * Elevation above the horizon, radians.
 *
 * The angle has been round-tripped by playtests: 35° buried actors behind
 * uniformly tall walls; 50° fixed that but turned the maze into a flat
 * floor-plan of wall TOPS. 38° is the Diablo-ish side view (D2 itself is 2:1
 * dimetric, ~27°) — and it only works because wall height is now STRUCTURAL
 * (see WALL_H/WALL_LOW): the camera-side rim of every corridor is knee-high,
 * so no angle can make a wall cover the corridor behind it.
 */
export const CAMERA_TILT = (38 * Math.PI) / 180;
/**
 * Horizontal rotation — TRUE isometric. At 45° the grid renders as diamonds
 * and every wall shows TWO faces (south + east), which is most of what makes
 * Diablo read as 3D. The camera sits to the world's south-east.
 */
export const CAMERA_YAW = (45 * Math.PI) / 180;
export const CAMERA_DIST = 24; // irrelevant to scale (ortho), just needs to clear geometry

// ── Sprites ─────────────────────────────────────────────────────
/**
 * The AUTHORING box — the COORDINATE SYSTEM every painter writes in.
 *
 * `cel-painter.ts` and `figure.ts` place every coordinate in this space (CX=64,
 * GROUND=118), so it is a coordinate system, not a resolution, and changing it
 * would move all the art. It is deliberately NOT the size anything is painted,
 * stored or displayed at.
 *
 * Split out from SPRITE_PX on 2026-07-29. The two were one constant, which
 * silently welded the art's coordinate space to the supersample buffer's size —
 * so the buffer could not be resized without moving every limb in the game.
 * They are now independent: author here, rasterise at SPRITE_PX, store at
 * SPRITE_PIXEL_GRID.
 */
export const ART_PX = 128; // painter coordinate space, unitless

/**
 * The SUPERSAMPLE buffer — the size a frame is actually rasterised at, before
 * the crush down to SPRITE_PIXEL_GRID.
 *
 * MUST be an exact integer multiple of SPRITE_PIXEL_GRID. That is the whole
 * reason this constant exists separately from ART_PX. The old pairing painted
 * at 128 and crushed to 72, a ratio of 1.7778: every output texel averaged a
 * fractional span of source pixels, so the box filter's boundaries fell BETWEEN
 * source pixels and a hard edge in the art was guaranteed to smear across two
 * texels no matter where it sat. At 216 → 108 the ratio is exactly 2, every
 * output texel is exactly 4 source pixels, and an edge that lands on an even
 * source pixel stays a single-texel edge.
 *
 * 2x rather than 3x is a measured choice: interleaved over five rounds, one
 * 45-frame sheet paints in 94.8 ms at 128, 106.8 ms at 144 and 133.1 ms at 216.
 * The supersample is there to anti-alias curved outlines before the crush, and
 * 2x does that; 3x costs 40% more paint for a second decimal place.
 */
// Written from PPU rather than from SPRITE_PIXEL_GRID only because the grid is
// declared further down this file; the identity `SPRITE_PX === 2 * grid` is the
// one that matters and `sprite-scale.test.ts` asserts it directly.
export const SPRITE_PX = PPU * 3; // rasterisation buffer, always 2 × grid

/**
 * The STORED art resolution — the atlas cell size, and the real fidelity dial.
 *
 * The 128px paint is area-downscaled to this grid ONCE, dithered, palette-
 * snapped, and written to the atlas at this size. It is not upscaled back.
 *
 * The old pipeline crushed to 52 and then nearest-upscaled back into a 128px
 * cell (128/52 = 2.46, so the "pixels" were unevenly 2 and 3 px wide inside
 * the texture), which the GPU then minified to ~70px on screen. Three
 * resamplings, two at non-integer ratios, to show 52 pixels of art. Now it is
 * one resample, and 72 texels map 1:1 to 72 screen pixels.
 *
 * 72 rather than 52 is also a real fidelity jump: ~52px is the awkward middle
 * where a face is 2-3 px and reads as mush, while ~72px supports actual facial
 * features, distinct hands and 4-5 shade ramps that hold up. It is the
 * resolution where characters stop looking low-res and start looking
 * deliberately pixel-art. Must stay an integer multiple of PPU's reciprocal —
 * i.e. SPRITE_PIXEL_GRID / PPU must be exact — see SPRITE_UNITS.
 */
/*
 * ── SPRITE:TILE RATIO 9/8 → 3/2 (2026-08-03, "the sprites are crunched too
 * small") ─────────────────────────────────────────────────────────────────────
 *
 * An actor used to stand 1.125 tiles tall — barely taller than the floor tile
 * it walks on, which is the least pixels a sprite can be given in a tile world.
 * The genre standard is well above that: LTTP's Link is 1.5 tiles, Chrono
 * Trigger and Secret of Mana characters run 1.5-2, and Ragnarok's sprites tower
 * over their floor cells. At 9/8 the whole 128-unit authored cel was crushed to
 * 63 texels at the default rung, one texel = 2.03 art units — every feature a
 * painter drew "a couple of units wide" was sub-texel and quantized to
 * confetti.
 *
 * At 3/2 the same rung stores 84 texels (+78% texel area), one texel = 1.52 art
 * units, and the actor reads at the size the art was actually authored for. The
 * camera FOV is untouched — tiles-on-screen is PPU's job, not this constant's.
 * The costs, priced deliberately: colliders and reach are unchanged, so visuals
 * now overlap walls/tiles the actor does not touch (exactly what RO/SNES do);
 * atlas cells and the supersample buffer grow ~1.78x in area, paid at boot.
 *
 * The identity constraints still bind: grid = SPRITE_UNITS × PPU must be a
 * whole number (PPU even, satisfied by every rung), and SPRITE_PX = 2 × grid
 * keeps the crush an exact box filter.
 */
export const SPRITE_PIXEL_GRID = (PPU * 3) / 2;

/**
 * Actor plane size, world units.
 *
 * MUST equal SPRITE_PIXEL_GRID / PPU. That identity is the whole ballgame for
 * sprite crispness: it makes one stored art pixel land on exactly one render
 * pixel (72 / 64 = 1.125 units → 1.125 × 64 = 72 px on screen for 72 texels).
 *
 * It used to be 1.1 against a 52px grid, which spanned 70.4 render pixels —
 * a ratio of 1.354. With NearestFilter that means art pixels covering one
 * screen pixel in some places and two in others, in an irregular pattern that
 * shifts as the actor walks. That is what "blurry"/"muddy" actually was: not
 * a soft filter (filtering was already NEAREST) but uneven pixel sizes and
 * destructive undersampling. `sprite.test.ts` asserts the identity so a future
 * edit to either number has to keep it.
 */
export const SPRITE_UNITS = SPRITE_PIXEL_GRID / PPU; // 3/2 = 1.5, binary-exact

// ── Style toggles ───────────────────────────────────────────────
//
// ── THE SCREEN-SPACE PIXEL FILTERS ARE RETIRED (2026-08-03) ──────────────────
// All four default OFF, their options rows are gone, and settings-save no
// longer honours a stored override — every player gets the clean frame.
//
// Why: the screen-wide palette snap was re-quantizing ALREADY-QUANTIZED art.
// Sprites are palette-locked per-sprite at the atlas (the RO/SNES model — that
// is where the pixel identity lives), so the only thing the screen snap had
// left to grind was the 3D environment's lit colours, which it posterized into
// the granular confetti the playtests kept flagging. SNES-era cleanliness comes
// from clean indexed ASSETS, never from a screen posterize; with the snap off
// the scene keeps its true lit colours and the sprites stay pixel art.
// Dither and scanlines existed to serve the snap (break its banding / dress its
// grid) and retire with it; the depth-edge ink pass goes too — baked selout ink
// in the figures already carries the outline job.
// The uniforms and setters survive for the debug surface and any future,
// better-behaved filter.
export const QUANTIZE_DEFAULT = false; // screen-space palette snap — retired, see above
export const DITHER_DEFAULT = false; // ordered dither — only existed to serve the snap
export const SCANLINE_DEFAULT = false; // CRT scanlines — retired with the rest of the screen dressing
export const OUTLINE_DEFAULT = false; // depth-edge ink — figures carry baked selout ink instead

/**
 * ── THE CEL GRADE (2026-08-03, "the soft glow makes everything look blurry") ──
 *
 * Retiring the palette snap left NOTHING banding the frame. What the player
 * then saw was the raw lit render: smooth continuous light falloff across every
 * floor and wall, and the ambient + hemi mix pulling each material toward grey.
 * Measured on the tavern (seed 777, real WebGPU adapter, the frame the report
 * came with): the floor carries one unbroken gradient corner to corner. No
 * pixel is out of focus — the SHADING is what reads as blur, because a smooth
 * gradient is what a blur looks like.
 *
 * The obvious undo — turn `QUANTIZE_DEFAULT` back on — was tried FIRST and
 * measured, and it is not the fix. Seeded A/B, same adapter:
 *
 *     tavern   bold and flat, no gradient          ✔ what the report asked for
 *     maze     rot-green family's ramp reaches void in two rungs, so the
 *              checkerboard goes hard black-on-green and the walls vanish  ✘
 *
 * plus the ordered dither's per-pixel confetti over every floor — which is the
 * look the 2026-08-03 playtest rejected in the first place.
 *
 * So the banding is done on LUMA, not on the palette. Two terms, both applied
 * to the already-sRGB lit colour at the end of `finalNode`:
 *
 *   POSTERIZE  round the luma to `CEL_STEPS` rungs and rescale the pixel's own
 *              chroma onto it. A gradient becomes flat bands; hue is untouched,
 *              so torchlight stays warm and no pixel can be relocated into
 *              another material's family — which is exactly what the
 *              screen-wide snap did and why it is not coming back.
 *   SATURATE   push each pixel away from its own grey. The ambient + hemi mix
 *              is what greyed the materials; this buys the boldness back
 *              without touching the lighting rig, which every biome tints.
 *
 * Neither term can produce confetti: both are monotone functions of the pixel's
 * OWN value, so two neighbours that were close stay close. That is the property
 * the palette snap could not have — its output space is other materials.
 */
export const CEL_DEFAULT = true;
/**
 * Luma rungs the posterize snaps to, across 0..1.
 *
 * Counted in sRGB luma, NOT linear: the composite has already run its
 * linear→sRGB transfer by the time the grade sees the pixel, so equal steps here
 * are roughly equal PERCEPTUAL steps and the dungeon's dark end gets rungs where
 * the eye can see them. In linear the same count would spend most of its rungs
 * on highlights this game does not have.
 */
/**
 * ── 10 IS A MEASURED NUMBER, AND IT WAS NOT THE FIRST GUESS ──
 * Swept live through `__tavernCel` / `__dungeonCel` on a real WebGPU adapter,
 * seed 777, judging the tavern (all flat floor and lamplight — the worst case
 * for a gradient) and floor 1 (a checkerboard — the worst case for over-banding)
 * from the SAME build:
 *
 *      5   tavern flat, but the walls collapse into one another and the dark
 *          half of the room goes to black; detail the art drew is gone
 *      8   tavern ideal — and it MERGES THE MAZE'S CHECKERBOARD. Adjacent tiles
 *          differ by less than a rung, so the floor grid dissolves into one
 *          field of moss and the level's readability goes with it
 *     10   both: tavern floor still flat bands, checkerboard still legible  ←
 *     12   the tavern's gradient is visibly back; the grade stops doing its job
 *
 * Floor 1 is what pins the ceiling here, and nothing in the tavern would have
 * revealed it — a one-room A/B would have shipped 8.
 */
export const CEL_STEPS = 10;
/**
 * ── THE RUNGS ARE NOT EVENLY SPACED, AND THAT IS THE WHOLE FIX ──────────────
 * (2026-08-03, "the map looks grainy — you're using the least colours possible")
 *
 * Rung k lands at `(k / CEL_STEPS) ^ (1 / CEL_CURVE)`. At 1 the rungs are even,
 * which is what shipped and what made the map look like noise.
 *
 * The reported symptom was "a filter making it red and grainy", and the grain is
 * NOT the banding — it is a CRUSH. Evenly spaced, ten rungs put the first one at
 * luma 0.1, so every pixel dimmer than 0.05 is presented as PURE BLACK. This
 * dungeon lives almost entirely under 0.35 and the flagstone painter
 * (maze/build.ts `makeFloorTexture`) scatters single-pixel speckle one palette
 * step away from the stone body, so that boundary runs straight through the
 * floor texture. Measured on the Bloodworks masonry (entries 11 and 12 adjacent)
 * across the lighting range a torch-lit floor spans:
 *
 *     spacing      speckle crushed to black    worst pair amplification
 *     even (1.0)        11% of the range       ∞   — one side IS black
 *     curve 0.5          0% of the range       1.41x
 *
 * A neighbour pair the art drew at 1.59:1 was being shown at ∞:1 over a ninth of
 * the floor, per pixel, on a texture designed to be subtle. That reads as dirt.
 *
 * 0.5 also spends the rungs where the picture is: six of eleven land under luma
 * 0.35 against four evenly (and three of those four are above anything the scene
 * reaches). The absolute step shrinks toward black — 0.01, 0.03, 0.05 … 0.19 —
 * so shading stays BOLD in the torch pools, which is where cel shading is meant
 * to be bold, and stops manufacturing contrast in the shadows.
 *
 * Live A/B without a rebuild: `__dungeonCel(steps, sat, curve)` / `__tavernCel`.
 * `__dungeonCel(10, 1.35, 1)` is exactly the pre-2026-08-03 look.
 */
export const CEL_CURVE = 0.5;
/**
 * Saturation multiplier about each pixel's own luma. 1 = unchanged.
 *
 * Clamped in the shader, so a value that would drive a channel past 1 flattens
 * to the primary rather than wrapping. The clamp is the failure mode that cannot
 * be undone downstream — a clipped channel has lost its hue — so this is set
 * under, not over.
 *
 * WAS 1.35, lowered with the curve above. 1.35 was chosen to buy boldness back
 * from an ambient+hemi mix that greys the materials, and it did, but it was also
 * doing a second job it should not have been: amplifying the chroma of a frame
 * whose luma had just been crushed into three levels. With the rungs spaced
 * properly the picture carries its own contrast, and the same 1.35 on top of it
 * pushed the Bloodworks — a biome that is already one blood ramp for all of its
 * masonry (maze/build.ts BIOME_STONE) — to a flat screaming red.
 */
export const CEL_SATURATION = 1.15;
/**
 * Luma step (rough-gamma space, 0..1) a COLOUR edge must exceed before the ink
 * pass darkens it — the second outline term, added because a depth edge cannot
 * see a silhouette at the same depth as its background.
 *
 * This is the knob that decides mud vs pixel art, so it is a measured number
 * and not a taste: flagstone grout, the Bayer dither and the AO ring all
 * produce steps around 0.05-0.12, while a material change or a silhouette
 * against the floor is 0.25 and up. Below ~0.2 the whole screen inks and the
 * art turns to mush; that failure is worse than missing an edge.
 *
 * ── RE-TUNED 2026-07-30, BECAUSE THE TERM CHANGED WHAT IT READS ──
 *
 * 0.26 was measured against the LIT frame. The term now samples the ALBEDO
 * (see `pixel-pass.ts`), and material steps are LARGER there — the lighting was
 * compressing them by rendering everything at roughly 0.4x. Leaving the number
 * alone would have been the subtler mistake: same constant, different space,
 * and the screen inks harder for a reason nothing in the code would explain.
 *
 * Measured over the cross-family material boundaries this term exists to catch:
 *
 *     threshold   caught on the LIT frame   caught on the ALBEDO
 *       0.26              29.1%                    46.9%
 *       0.34              16.8%                    36.0%
 *       0.40              10.1%                    27.6%
 *
 * 0.40 on the albedo reproduces the ink DENSITY 0.26 on the lit frame produced
 * (27.6% against 29.1%), which is the conservative choice: the ink now lands on
 * material boundaries instead of on a lighting-contaminated mixture, without
 * also changing how much of it there is. Two variables, one wave.
 *
 * The frame is the judge, not this table: `--census`'s void/ink share IS the ink
 * density, so an A/B that holds it roughly flat is what confirms the number.
 */
export const OUTLINE_EDGE_THRESHOLD = 0.4;

// ── Lighting & depth (the "make the 3D read as 3D" pass) ────────
/**
 * The whole scene used to be lit by a single very-bright flat AmbientLight, so
 * genuine box geometry read as a flat floor-plan: no surface has a light side
 * and a dark side. This pass adds real shape back.
 *
 *  - Surfaces are MeshStandardMaterial with procedural NORMAL MAPS baked from
 *    the same noise that paints the diffuse, so flagstone mortar and wall
 *    courses become lit relief that reacts to the torches you walk past.
 *  - One shadow-casting DirectionalLight (cold, high, raking) gives walls a
 *    cast shadow into the corridors. Its ortho shadow frustum follows the
 *    camera target so a small high-res map covers the whole visible area.
 *  - Ambient drops from the old 4.0 to a level that still keeps unlit stone
 *    off pure black (the quantizer crushes anything darker to void), but low
 *    enough that the directional + torches actually model the geometry.
 */
export const AMBIENT_INTENSITY = 3.5; // readability floor: SOTN is dark in MOOD, never illegible — the quantizer crushes anything dimmer to void
export const HEMI_INTENSITY = 1.1; // sky/ground tint
export const DIR_INTENSITY = 1.5; // the raking cold key light that casts shadows and shapes the normal-mapped stone
/**
 * A dim personal lamp that follows the hero. Not diegetic — it's the
 * Castlevania readability rule: whatever else is dark, the player and the
 * tiles they're about to step on always read.
 */
export const PLAYER_LAMP_INTENSITY = 1.6;
export const PLAYER_LAMP_RANGE = 4.5;
export const DIR_HEIGHT = 14; // how high above the target the sun sits
// 1024, down from 2048: the scene is quantized to a 1280×720 pixel-art target,
// where a 2k shadow map is resolution the eye never sees — but the GPU pays
// for the full depth pass. Combined with the 30 Hz shadow throttle in the
// loop this cuts shadow cost ~8×.
export const SHADOW_MAP_SIZE = 1024; // shadow render resolution
/** Half-extent (world units) of the directional light's ortho shadow frustum. */
export const SHADOW_AREA = 16;
/** Shadow darkness: 0 = black shadows, 1 = invisible. Kept soft so it snaps to a stone step, not void. */
export const SHADOW_OPACITY = 0.42;

// ── Atmosphere / fog ────────────────────────────────────────────
/**
 * LINEAR fog in the void colour, keyed on distance-from-camera. It must be
 * linear (near/far), not exponential: under an ortho camera every fragment
 * sits in a narrow distance band (~CAMERA_DIST), so density-based fog would
 * blanket the whole frame uniformly. near/far tuned just past the camera so
 * only the far (upper) end of the view fades into the dark.
 */
export const FOG_NEAR = 30;
export const FOG_FAR = 58;

// ── Bloom (torches / arcane glow bleed light) ───────────────────
/** Luminance above which a pixel is considered "emissive" and blooms. */
export const BLOOM_THRESHOLD = 0.7;
export const BLOOM_STRENGTH = 0.9;
export const BLOOM_RADIUS = 2.2; // blur spread in half-res texels
export const BLOOM_DEFAULT = true;

// ── Screen-space ambient occlusion (folded into the final pass) ──
/** AO sampling radius, in render-target texels. */
export const AO_RADIUS = 14;
export const AO_STRENGTH = 0.85; // how hard concave corners darken
export const AO_DEFAULT = true;

// ── Vignette (modern framing — darkens the screen corners) ──────
export const VIGNETTE = 0.32; // pulled back from 0.5 — it was eating the corners' readability

// (SPRITE_PIXEL_GRID moved up into the Sprites block — SPRITE_UNITS is now
// derived from it, so it has to be declared first.)

// ── Set dressing density (Phase 1) ──────────────────────────────
/** ~1 in N eligible full-wall faces grows a pilaster / hangs a banner. */
export const PILASTER_EVERY = 5;
export const BANNER_EVERY = 7;
/** ~1 in N eligible corner tiles gets a crate or barrel hugging the wall. */
export const CLUTTER_EVERY = 6;

// ── Torch flames (Phase 3) ──────────────────────────────────────
export const FLAME_FRAMES = 4;
export const FLAME_FPS = 9;

/** Ambient dust motes per second drifting near the player. */
export const MOTE_RATE = 2.2;

// ── Animation ───────────────────────────────────────────────────
export const FPS_IDLE = 3;
export const FPS_WALK = 8;
export const FPS_ATTACK = 12;
export const FPS_DEATH = 6;
/**
 * Roll clip: 6 frames across ~ROLL_DURATION (0.42s) → 14fps.
 *
 * Was 4 frames at 10fps, all four of them mid-tumble — the knight snapped from
 * standing to fully balled and back, so the roll had a spin but no ARC. The two
 * frames added are the dip that loads it and the rise that spends it, and the
 * rate moves with them: a roll animation that outlasts its i-frames (0.42s) is
 * a lie about how long you are safe.
 */
export const FPS_ROLL = 14;
/** The tavern one-shots: the gear-hoist flourish and the anvil hammer loop. */
export const FPS_EQUIP = 8;
export const FPS_FORGE = 7;
/**
 * Run clip base rate — the sprint gait. The ANIMATOR's playback rate is then
 * multiplied by (1 + RUN_RATE_RAMP·sprintCharge) in player.ts, so the run
 * visibly quickens as the spool fills: the animation IS the ramp-up readout.
 */
export const FPS_RUN = 10;
export const RUN_RATE_RAMP = 0.6; // full spool plays the run clip 1.6× faster

// ── Telegraph clips ─────────────────────────────────────────────
//
// Each of these is paced so the clip RUNS OUT exactly when its mechanic does,
// and then holds. A telegraph that loops back to its first frame mid-window is
// a telegraph that lies about how much time you have left.
/** Leaper crouch: 3 frames across LEAP_WINDUP (0.45s) → the last frame lands
 *  on the release. */
export const FPS_CROUCH = 7;
/** Pack-hunter stalk: a 4-frame LOOP, deliberately slower than the walk (8) —
 *  half speed on the feet (PACK_STALK_MULT) should read as half speed. */
export const FPS_WAIT = 5;
/** Ambusher spring / strafer dart: 3 frames in 0.3s of a 1.2s burst, then held
 *  in the committed lunge pose for the rest of it. */
export const FPS_WAKE = 10;
/** Stagger recoil: 3 frames in 0.33s, inside even the shortest stagger
 *  (STAGGER_TIME_MIN 0.25s is one frame short, which is correct — a glancing
 *  stagger should look clipped). */
export const FPS_STUMBLE = 9;

// ── Torch light pool ────────────────────────────────────────────
/**
 * Every torch gets a flame mesh, but only the nearest N to the player carry a
 * real PointLight — dozens of live point lights melt a forward renderer, and
 * off-screen torches can't be seen lighting anything anyway.
 */
// 6, down from 12: every MeshStandardMaterial fragment loops over ALL live
// point lights, and the pinball floors carry ~150+ materials — halving the
// pool nearly halves the biggest per-pixel cost in the scene. The far half of
// the old pool sat on torches outside the small follow-cam view anyway.
export const TORCH_LIGHT_POOL = 6;

// ── Camera follow ───────────────────────────────────────────────
export const CAM_DEADZONE = 0.7; // player can wander this far before the camera moves
export const CAM_LERP = 6; // catch-up rate, 1/sec
