/**
 * MODE REGISTRY — every generation task the forge offers, declaratively.
 *
 * The panel is deliberately NOT a ComfyUI mirror: a mode is a task (turn the
 * character, animate it, fix its hand), its `fields` are the few decisions a
 * sprite author actually makes, and everything else — CFG, samplers, sigma
 * shift, LoRA placement — is baked into the graph builders at the measured
 * sweet spots. Re-tuning those belongs in ComfyUI's own frontend against
 * the same server; once a value wins there, it gets baked HERE.
 *
 * One mode = one entry: prompt template, which LoRAs ride along and when,
 * which graph builds, and the coupled quality/fast parameter bundles. The
 * route and the CLI both dispatch through this table, so a prompt tweak
 * lands everywhere at once (they used to be duplicated verbatim).
 *
 * `ctx` is injected by the caller so this file stays import-pure over
 * graphs.mjs (testable without a filesystem):
 *   ctx.has(optionId)   manifest option installed on disk?
 *   ctx.lora(optionId)  its filename relative to models/loras/, or null
 *   ctx.unet(slotId)    the chosen unet filename for a pick-one slot, or null
 *   ctx.fast            use the Lightning bundle (caller verified installed)
 *   ctx.images          uploaded server-side names {init, end, mask, style}
 *   ctx.seed
 */
import { bgRemove, h3Length, minimaxH3I2V, qwenEdit, qwenInpaint, wanI2V, wanTi2v5B } from "./graphs.mjs";

/**
 * Lightning distills change the OPERATING POINT — steps and cfg move
 * together with the LoRA or the output is mush. These are the only two
 * sampler-parameter bundles in the system; they live here so no route or
 * panel can half-apply one.
 */
const QWEN_FAST = { optionId: "qwen-lightning-8step", strength: 1.0, steps: 8, cfg: 1.0 };
const WAN_FAST = {
  highId: "wan-lightning-high",
  lowId: "wan-lightning-low",
  strength: 1.0,
  steps: 4,
  cfg: 1.0,
};

/** Qwen leg: style lock + optional fast bundle → {loras, steps, cfg}. */
function qwenBundle(ctx, { styleLock = true } = {}) {
  const loras = [];
  if (styleLock && ctx.has("tarn59-pixel-style")) {
    loras.push({ name: ctx.lora("tarn59-pixel-style"), strength: 0.8 });
  }
  if (ctx.fast && ctx.has(QWEN_FAST.optionId)) {
    loras.push({ name: ctx.lora(QWEN_FAST.optionId), strength: QWEN_FAST.strength });
    return { loras, steps: QWEN_FAST.steps, cfg: QWEN_FAST.cfg };
  }
  return { loras, steps: 20, cfg: 2.5 };
}

/** Wan leg: pixel-motion adapter (+walk specialist) + optional fast pair. */
function wanBundle(ctx, { walk = false } = {}) {
  const high = [];
  const low = [];
  if (ctx.has("styly-pixel-animate")) {
    const styly = { name: ctx.lora("styly-pixel-animate"), strength: 0.8 };
    high.push(styly);
    low.push(styly);
  }
  // pix3lwalk ships a HIGH-NOISE half only — attaching it low too would
  // double-style the refinement (the f8c2086 lesson).
  if (walk && ctx.has("pix3lwalk")) {
    high.push({ name: ctx.lora("pix3lwalk"), strength: 0.8 });
  }
  if (ctx.fast && ctx.has(WAN_FAST.highId) && ctx.has(WAN_FAST.lowId)) {
    high.push({ name: ctx.lora(WAN_FAST.highId), strength: WAN_FAST.strength });
    low.push({ name: ctx.lora(WAN_FAST.lowId), strength: WAN_FAST.strength });
    return { lorasHigh: high, lorasLow: low, steps: WAN_FAST.steps, cfg: WAN_FAST.cfg };
  }
  return { lorasHigh: high, lorasLow: low, steps: 20, cfg: 3.5 };
}

/** Is the fast bundle actually installable for a leg right now? */
export function fastAvailable(leg, has) {
  if (leg === "qwen") return has(QWEN_FAST.optionId);
  return has(WAN_FAST.highId) && has(WAN_FAST.lowId);
}

/**
 * THE SMALL WAN LEG — TI2V-5B instead of the A14B expert pair.
 *
 * Both quant ids are accepted so a Q6 install is not silently ignored; the
 * caller takes whichever is present, Q8 first because it is the recommended
 * one. `wan22-vae` is in the AND rather than being assumed, because the 2.1
 * VAE decodes 5B to garbage instead of raising — an availability check that
 * omits it would report "5B is ready" for a setup that produces noise.
 */
const WAN_SMALL = { unetIds: ["wan-ti2v-5b-q8", "wan-ti2v-5b-q6"], vaeId: "wan22-vae", steps: 20, cfg: 3.5 };

export function smallAvailable(leg, has) {
  if (leg !== "wan") return false;
  return WAN_SMALL.unetIds.some((id) => has(id)) && has(WAN_SMALL.vaeId);
}

/**
 * The 5B bundle: which weights, and the LoRA list — which is EMPTY, on purpose.
 *
 * `wanBundle` above attaches `styly pixel-animate` and `pix3lwalk`; both are
 * A14B adapters (one applied to both experts, one a high-noise half) and
 * neither can load on a single dense model. Returning an empty list here is the
 * honest version of that, and `graphs.wanTi2v5B` throws if one is passed
 * anyway — the two together mean a 5B run cannot quietly become an unstyled
 * run that nobody notices.
 */
function wanSmallBundle(ctx) {
  const unetId = WAN_SMALL.unetIds.find((id) => ctx.has(id));
  return {
    loras: [],
    steps: WAN_SMALL.steps,
    cfg: WAN_SMALL.cfg,
    unet: unetId ? ctx.fileOf(unetId) : undefined,
    vae: ctx.fileOf(WAN_SMALL.vaeId) ?? undefined,
    /** Surfaced so the panel can say what was given up, rather than it being invisible. */
    droppedLoras: ["styly-pixel-animate", "pix3lwalk"].filter((id) => ctx.has(id)),
  };
}

/**
 * Build a Wan clip on whichever animation leg the request asked for.
 *
 * Both wan modes route through here so the leg choice cannot be made in one
 * mode and forgotten in the other — the drift that this file's header already
 * complains about for prompts.
 *
 * ⚠️ THE SMALL LEG CANNOT PIN A LAST FRAME, AND THAT IS NOT A WIRING GAP.
 * `WanFirstLastFrameToVideo` builds 2.1-format conditioning for the A14B pair.
 * The 2.2 latent path has exactly one node, `Wan22ImageToVideoLatent`, and its
 * schema has `start_image` and no `end_image` — first/last pinning does not
 * exist for TI2V-5B in this ComfyUI. So `inbetween` — step 5 of
 * PLAN_KEYFRAME_PIPELINE, and the step that stops Wan inventing where a motion
 * is going — is A14B-only. Refusing loudly here is the whole point: silently
 * dropping `end_image` would return a free-running clip that LOOKS like an
 * in-between and is exactly the failure the plan exists to end.
 */
function buildWanClip({ image, endImage = null, prompt, extraNegative = null, length, ctx, walk = false }) {
  if (ctx.small) {
    if (endImage) {
      throw new Error(
        "[modes] the small leg (TI2V-5B) cannot pin a last frame — Wan22ImageToVideoLatent has no end_image " +
          "input, so an in-between would silently become a free-running clip. Run in-betweens on the A14B pair.",
      );
    }
    const small = wanSmallBundle(ctx);
    return wanTi2v5B({
      image, prompt, extraNegative, length, seed: ctx.seed,
      unet: small.unet, vae: small.vae, loras: small.loras, steps: small.steps, cfg: small.cfg,
    });
  }
  return wanI2V({
    image, endImage, prompt, extraNegative, length, seed: ctx.seed,
    unetHigh: ctx.unet("anim-high") ?? undefined,
    unetLow: ctx.unet("anim-low") ?? undefined,
    ...wanBundle(ctx, { walk }),
  });
}

/**
 * THE FACINGS — and the `sks` column is a TRAINED VOCABULARY, not prose.
 *
 * When `fal-multi-angle` is installed the rotate prompt stops being a sentence
 * and becomes that LoRA's grammar: `<sks> [azimuth] [elevation] [distance]`,
 * 96 poses = 4 elevations × 8 azimuths × 3 distances, trained on Gaussian-
 * Splatting renders of one object. The eight azimuths below are the LoRA's
 * exact tokens. Anything else is an untrained string that falls back to the
 * base model's freeform turning — which is the thing the LoRA exists to
 * replace, so a typo here degrades silently to the weaker path.
 *
 *   front view · front-right quarter view · right side view ·
 *   back-right quarter view · back view · back-left quarter view ·
 *   left side view · front-left quarter view
 *
 * ── WHY THE QUARTER VIEWS ARE HERE WHEN THE ENGINE HAS THREE FACINGS ────────
 *
 * `Dir` is `"S" | "N" | "E"`, so the game cannot draw a diagonal today and
 * chapter 11 recommends deciding that AFTER one creature is complete. These
 * rows are listed anyway because the question "can we even make diagonals"
 * is settled by this table: the LoRA was trained on all eight, so a diagonal
 * facing costs a `rotate` run like any other and the blocker is purely the
 * `Record<Dir, …>` tables. Marked `diagonal` so the panel can group them and
 * the three-facing batch below never picks one up by accident.
 *
 * `left` is deliberately NOT a game facing — W is drawn by flipping E. It is
 * kept as a reference render for checking that a mirror actually reads.
 */
export const FACINGS = [
  { id: "E", label: "right — E, the authored side", phrase: "right, seen from the side", sks: "right side view" },
  { id: "left", label: "left side (engine mirrors E — for reference only)", phrase: "left, seen from the side", sks: "left side view" },
  { id: "S", label: "toward camera — S", phrase: "the camera (front view)", sks: "front view" },
  { id: "N", label: "away — N", phrase: "away from the camera (back view)", sks: "back view" },
  // The four the engine cannot consume yet. See the block comment above.
  { id: "SE", label: "SE — toward camera, right (needs a Dir change)", phrase: "the camera and to the right, a three-quarter front view", sks: "front-right quarter view", diagonal: true },
  { id: "NE", label: "NE — away, right (needs a Dir change)", phrase: "away from the camera and to the right, a three-quarter back view", sks: "back-right quarter view", diagonal: true },
  { id: "SW", label: "SW — toward camera, left (needs a Dir change)", phrase: "the camera and to the left, a three-quarter front view", sks: "front-left quarter view", diagonal: true },
  { id: "NW", label: "NW — away, left (needs a Dir change)", phrase: "away from the camera and to the left, a three-quarter back view", sks: "back-left quarter view", diagonal: true },
];

/**
 * The move-set preprompts: one entry per base movement a game character
 * needs. `action` is what gets injected into the animate template; `clip`
 * is the game clip the frames land under (stagger is `stumble` never
 * `hurt`; a block maps onto the game's `crouch`). Tune the words HERE —
 * the one-click batch below and the preset dropdown both read this table.
 */
const ANIMATE_PRESETS = [
  { id: "idle", label: "idle sway", action: "standing in place, breathing and swaying gently, an idle animation", clip: "idle" },
  /**
   * THE QUADRUPED IDLE — and idle is the clip most likely to come back DEAD.
   *
   * The 08-07 failure: an idle measured 479×588 for all 21 frames, frame-to-
   * frame change 14% where a good sheet is 63%. Wan produced no motion at all.
   * That is the documented behaviour of free-running I2V on small movement, and
   * an idle is nothing but small movement, so this preset gets the same
   * treatment `walk4` got — mechanics, named body parts, and a slide ban.
   *
   * The generic `idle` above says "breathing and swaying", and its keyframe
   * twin says "chest and shoulders lifted". That is biped vocabulary pointed at
   * an animal whose breathing reads through the RIBCAGE and whose idle reads
   * through the head, tail and ears — a dog standing four-square does not sway,
   * it shifts weight. Asking a quadruped to sway invites the one thing that
   * must not happen here: the model turning the body, because a turn is the
   * cheapest way to make a pixel move.
   *
   * `avoid` therefore bans travel AND rotation, which `walk4` does not need to.
   * An idle that walks out of frame is a failed generation; an idle that turns
   * is worse, because it silently re-faces a sheet built for one facing.
   */
  {
    id: "idle4",
    label: "idle — four legs (breathing in place)",
    alt: true,
    action:
      "standing still on all four legs, alert and breathing, the ribcage swelling and settling, " +
      "the head lifting and lowering slightly, the tail swaying slowly, ears twitching, " +
      "all four paws staying planted on the ground, a subtle looping idle animation",
    avoid:
      "walking, stepping, taking a step, moving forward, travelling across the frame, turning, " +
      "rotating, changing direction, rearing, sitting, lying down, jumping, extra legs, legs merging",
    clip: "idle",
  },
  // Walk/run describe MECHANICS, not mood: "walking in place, smooth" reads
  // as "keep everything anchored" and the model glides the feet along the
  // floor (measured on the frog, 08-05). Lift-and-plant language plus an
  // explicit slide ban in `avoid` is what buys visible leg motion.
  {
    id: "walk",
    label: "walk cycle",
    action:
      "walking with a springy exaggerated stride, knees lifting high, each foot clearly rising off the ground and planting down again, a full two-step side-view walk cycle",
    avoid: "feet sliding along the ground, gliding, ice skating, floating, shuffling, legs merging",
    clip: "walk",
  },
  /**
   * THE SAME MECHANICS, FOR AN ANIMAL — because `walk` is written for a biped
   * and a dog was being asked to perform it.
   *
   * The shipped `walk` says "a full TWO-STEP side-view walk cycle", which is
   * bipedal vocabulary. Handed to a quadruped it is not merely unhelpful, it
   * describes a different gait: a dog's walk is a FOUR-beat lateral sequence,
   * and asking for two steps invites the model to animate two of the four legs
   * and let the others follow. "the legs are mismatching how they are walking"
   * was the report, and this is the first thing to rule out.
   *
   * The anatomy clauses are not decoration. A quadruped's front leg bends
   * BACKWARD at the elbow and the hind leg bends FORWARD at the hock, which is
   * the single most common thing generative models get wrong on animals — they
   * draw four identical knees. The extra-leg ban is here for the same reason
   * `avoid` exists on `walk`: it is a failure this family of models has.
   *
   * Kept OUT of `MOVESET` (see `alt`) so the one-click batch does not generate
   * two walks and file both under the `walk` clip.
   */
  {
    id: "walk4",
    label: "walk cycle — four legs",
    alt: true,
    action:
      "walking on four legs in a steady four-beat gait, each paw lifting clearly off the ground and planting down again, " +
      "front legs and hind legs alternating on opposite sides, elbows bending backward and hocks bending forward, " +
      "the spine level and the head steady, a full side-view quadruped walk cycle",
    avoid:
      "feet sliding along the ground, gliding, ice skating, floating, shuffling, legs merging, " +
      "extra legs, five legs, missing leg, bipedal, standing upright, rearing, hopping",
    clip: "walk",
  },
  {
    id: "run",
    label: "run cycle",
    action:
      "sprinting with a forward lean, knees driving high, feet clearly leaving the ground with a moment of flight in each stride, a full two-step side-view run cycle",
    avoid: "feet sliding along the ground, gliding, ice skating, floating, shuffling, legs merging",
    clip: "run",
  },
  /**
   * THE QUADRUPED RUN — a GALLOP, which is not a fast walk.
   *
   * `run` above asks for "a full two-step side-view run cycle" with "knees
   * driving high", the same bipedal framing `walk4` exists to correct. Handed
   * to a dog it describes a gait the animal does not have, and the failure mode
   * is specific: the model renders a faster version of the walk — four legs
   * paddling in the same four-beat sequence — which at 8fps reads as a
   * sped-up walk rather than a charge, and the run clip stops being
   * distinguishable from the walk clip it sits next to.
   *
   * A galloping dog does two things a walk never does: the spine FLEXES and
   * EXTENDS (the back rounds as the hind legs swing under, then stretches as
   * they drive back), and both pairs leave the ground together in a suspension
   * phase. Those are the two clauses that make it read. Note the spine clause
   * is the exact OPPOSITE of `walk4`'s "the spine level and the head steady" —
   * that is the point, and it is why this could not be a tweak to `walk4`.
   *
   * Kept `alt` for the same reason as `walk4`: it targets the `run` clip that
   * `run` already targets, so the batch must not generate both.
   */
  {
    id: "run4",
    label: "run cycle — four legs (gallop)",
    alt: true,
    action:
      "galloping at full speed on four legs, front legs reaching far forward together and hind legs driving back together, " +
      "the spine flexing and extending with each stride, all four paws leaving the ground at once in a moment of suspension, " +
      "the head lowered and thrust forward, a full side-view quadruped gallop cycle",
    avoid:
      "feet sliding along the ground, gliding, ice skating, floating, shuffling, legs merging, " +
      "walking, trotting, extra legs, five legs, missing leg, bipedal, standing upright, rearing, hopping",
    clip: "run",
  },
  { id: "attack", label: "attack", action: "attacking with its weapon, one full swing", clip: "attack" },
  /**
   * THE BITE — because `attack` above hands a WEAPON to an animal.
   *
   * "attacking with its weapon, one full swing" is not merely unhelpful to a
   * quadruped, it names a prop the creature does not have, and a generative
   * model asked for a swing from a dog will find something to swing: a paw
   * raised like an arm, or a rearing biped. The extra-legs and rearing bans
   * from `walk4` apply here for the same reason.
   *
   * A canine attack is a LUNGE AND SNAP: the weight transfers onto the
   * forelegs, the head drives forward, the jaws open and close. It is a
   * one-shot, not a cycle, so it must NOT be generated with `--loop`.
   */
  /**
   * ── WRITTEN AS THREE BEATS, BECAUSE ONE SENTENCE READ AS A SNARL ───────────
   *
   * The first version said "lunging forward and biting … one full bite from
   * wind-up to snap" — the wind-up named once, as a trailing clause. Reported
   * by eye: "the hound looks like it's just showing its teeth." Measured:
   * churn 11.3% against the walk's 22.1%, half the movement on what should be
   * the most violent clip in the set.
   *
   * Two causes, and the template was the bigger one (see CYCLE_CLIPS). This is
   * the second: an attack reads through ANTICIPATION -> STRIKE -> FOLLOW
   * THROUGH, and the strike only lands because it contrasts with the coil
   * before it. Given one undifferentiated sentence the model averages the
   * whole thing into a mid-pose and animates the one part that can move
   * without contradicting "stay centred": the jaw.
   *
   * So the beats are numbered in the text and each names DIFFERENT body
   * mechanics, the way the keyframe presets already do. The `avoid` list bans
   * the specific failure observed — a stationary snarl — not just generic
   * badness, because "showing its teeth" is a perfectly good bite frame and
   * the defect is that it is the ONLY frame.
   */
  {
    id: "attack4",
    label: "attack — four legs (lunge and bite)",
    alt: true,
    action:
      "first coiling back on its haunches with the head drawn back and the shoulders gathering, " +
      "then exploding forward off the hind legs into a full lunge, the front paws leaving the ground, " +
      "the neck and spine extending straight out, the jaws opening wide and snapping shut on the target, " +
      "then landing heavily on the forelegs with the head low, a single committed bite",
    avoid:
      "standing still, snarling in place, growling without moving, only the mouth moving, only the jaw moving, " +
      "barking in place, holding a pose, the body staying upright and static, " +
      "weapon, sword, club, holding an object, swinging an arm, bipedal, " +
      "extra legs, five legs, missing leg, legs merging, floating",
    clip: "attack",
  },
  { id: "stumble", label: "getting hit (stagger)", action: "recoiling and stumbling backward as if struck, hurt", clip: "stumble" },
  /**
   * THE FLINCH. `stumble` above says "stumbling backward", which on four legs
   * reads as walking backwards rather than being hit. A struck animal drops its
   * head, twists away and its legs BUCKLE — the read is the collapse of posture,
   * not travel. One-shot; no `--loop`.
   */
  {
    id: "stumble4",
    label: "getting hit — four legs (flinch)",
    alt: true,
    action:
      "recoiling from a blow, the whole body flinching and twisting away, the head snapping down and to the side, " +
      "the legs buckling and scrabbling for footing, the tail tucking under, hurt and staggering",
    avoid:
      "walking backwards, stepping back calmly, standing upright, rearing, bipedal, extra legs, legs merging, floating",
    clip: "stumble",
  },
  { id: "defend", label: "defend (block)", action: "bracing defensively, guarding against an incoming blow, hunkering down", clip: "crouch" },
  /**
   * THE POUNCE TELEGRAPH, and the highest-stakes clip in the set.
   *
   * `render/tell-clips.ts` resolves the leaper tell to `crouch`, and there is NO
   * painter fallback — an unauthored crouch plays `idle`, which is how the hound
   * charged for weeks with no warning. `defend` above describes a SHIELD BLOCK
   * ("guarding against an incoming blow"), which is a knight's move; a hound
   * telegraphs by gathering to spring, and those two poses look nothing alike.
   *
   * It is a HELD pose, not a cycle: `anim.crouch` plays at 7fps ~ 0.43s against
   * LEAP_WINDUP's 0.45s, so the clip must END at its deepest gather — the pounce
   * starts from wherever this finishes. Definitely no `--loop`, which would drag
   * it back to standing.
   */
  {
    id: "defend4",
    label: "telegraph — four legs (gather to pounce)",
    alt: true,
    action:
      "crouching low to spring, the haunches gathering and loading under the body, the chest dropping toward the ground, " +
      "the shoulders coiling, the head lowered and locked forward on its target, the body settling deeper and holding, ready to pounce",
    avoid:
      "leaping, jumping, springing, pouncing, rising, standing up, walking, travelling, turning, " +
      "shield, blocking, guarding with an arm, standing upright, bipedal, extra legs, legs merging",
    clip: "crouch",
  },
  { id: "death", label: "death", action: "dying and collapsing to the ground", clip: "death" },
  /**
   * THE COLLAPSE. Two 08-06 death runs drove the field black and turned the
   * figure into particle VFX, which a sprite bakes in permanently — so the
   * dissolve vocabulary is banned here on top of the global negative. A
   * quadruped dies by folding: legs give way, hindquarters drop, the body rolls
   * onto its side. One-shot; no `--loop`, and it must END on the ground.
   */
  {
    id: "death4",
    label: "death — four legs (collapse)",
    alt: true,
    action:
      "collapsing and dying, the legs giving way beneath the body, the hindquarters dropping first, " +
      "the chest sinking to the ground, the head falling last, the body settling onto its side and going still",
    avoid:
      "dissolving, disintegrating, particles, smoke, glow, sparks, fading away, vanishing, " +
      "getting up, standing, walking, bipedal, rearing, extra legs, legs merging",
    clip: "death",
  },
  { id: "custom", label: "custom action…", action: "", clip: "" },
];

/**
 * The one-click batch: every base movement, one job each, in this order.
 *
 * `alt` presets are body-plan variants of a move that is already in the list —
 * they target the SAME game clip, so including them would generate two takes
 * and file both under one clip name. They are dropdown choices, not batch
 * entries.
 */
const MOVESET = ANIMATE_PRESETS.filter((p) => p.id !== "custom" && !p.alt);

/**
 * THE CLIPS THAT ARE CYCLES. Everything else is a ONE-SHOT.
 *
 * ── THE TEMPLATE WAS CANCELLING FOUR OF THE SEVEN CLIPS ─────────────────────
 *
 * Every animate prompt used to end with the same hardcoded tail:
 *
 *     "…, smooth looping animation, the character stays centered in frame, …"
 *
 * which is correct for a walk and actively wrong for an attack. Both clauses
 * suppress exactly what a lunge is:
 *
 *   "smooth LOOPING animation"        -> return to the pose you started in.
 *                                        An attack must END somewhere else.
 *   "the character STAYS CENTERED"    -> do not travel. Lunging is travelling.
 *
 * Handed both, the model keeps the only part of a bite that moves neither the
 * body nor the frame: the jaw. Reported by eye as "the hound looks like it's
 * just showing its teeth", and the measurement agrees — S:attack churned
 * **11.3%** against S:walk's **22.1%**, half the movement, on a move that
 * should be the most violent in the set.
 *
 * A one-shot instead gets: end somewhere different, and a locked-off camera
 * with the whole body in frame. Note it is NOT told to travel freely — the
 * sprite importer re-centres every cell on its own bounding box, so lateral
 * translation is discarded downstream anyway. The lunge has to read through
 * POSE (body extending, paws leaving the ground, weight thrown forward), which
 * survives registration, and "stays centered in frame" was killing the pose
 * along with the travel.
 *
 * Keyed on the CLIP, not the preset id — the same rule the `pix3lwalk` trigger
 * learned the hard way when `walk4` appeared and an id equality test silently
 * dropped it.
 */
const CYCLE_CLIPS = new Set(["idle", "walk", "run"]);

/**
 * ⚠️ DO NOT ADD A SHRINK BAN TO THE NEGATIVE. IT IS ALREADY THERE AND IT DOES
 * NOT WORK.
 *
 * Wan's shared negative in `graphs.mjs` has carried this all along:
 *
 *     "camera zoom, zoom in, zoom out, dolly, camera pan, camera movement,
 *      changing scale, character growing, character shrinking"
 *
 * The S attack shrank to barely more than a head with every one of those terms
 * active. A second copy on the preset was written while fixing this and thrown
 * away on measuring it — re-banning a banned thing is the "prompting harder"
 * dead end (chapter 10), which has already cost this repo a session.
 *
 * What DID hold the scale was a POSITIVE clause. The old tail said "the
 * character stays centered in frame" and the figure kept its size; removing it
 * for one-shots freed the pose and the scale went with it, negative
 * notwithstanding. Positive conditioning outranks the negative here, so the
 * one-shot tail states the constraint it needs — "stays the same size
 * throughout" — and does NOT restate the ban.
 */

/**
 * Pose scripts for the keyframe-sheet mode: 4 EXTREME poses per move —
 * the classic animator's keys, not in-betweens. The in-between mode fills
 * the middles later, so these deliberately disagree with each other as
 * much as the move allows; timid keys are what make motion slide.
 * `clip` files the cut cells under the right game clip, like the animate
 * presets do.
 *
 * ── EVERY KEY IS THE SAME CAMERA ────────────────────────────────────────
 * First measured run (frog, 2026-08-05): the four keys came back
 * front-facing → side → three-quarter → front, so the in-between animated
 * a TURN rather than a stride. Asked for "right foot planted far forward"
 * with no camera pinned, an edit model expresses the stride the easiest
 * way it can — by rotating the character. `camera` states the viewpoint
 * once per move and the prompt forbids turning between frames; a walk
 * reads from the side, a death reads better toward the camera.
 */
/**
 * THE CAMERA BELONGS TO THE FACING, NOT THE MOVE.
 *
 * Every move here used to pin its own viewpoint — walk and run from a true
 * side, attack and death from three-quarter — because each reads best that way
 * IN ISOLATION. In isolation is the problem: the game does not play one clip,
 * it cuts between them, and a creature that walks in profile and attacks in
 * three-quarter visibly teleports the moment combat starts. Every contact sheet
 * looked perfect while the sheet as a whole was broken.
 *
 * So the viewpoint is a property of the facing being built. An E sheet is
 * side-on for idle AND attack; an S sheet faces the camera throughout. It costs
 * the attack some drama and buys two things: the creature never pops, and every
 * cell in a facing becomes geometrically comparable — which is what lets
 * `drift.ts` compare them at all. A drift metric across mixed cameras measures
 * the camera.
 *
 * ⚠️ MIRRORED IN `build-plan.ts` as `CAMERA_BY_DIR`, because that file is
 * TypeScript and this one is plain ESM the route imports directly — neither can
 * import the other without dragging a build step into the generation path.
 * `camera-sync.test.ts` asserts the two agree, so a change here that is not
 * echoed there fails the suite rather than silently splitting the contract.
 */
export const CAMERA_BY_DIR = {
  E: "true side view, facing right, camera at eye level",
  S: "front view, facing the camera, camera at eye level",
  N: "back view, facing away from the camera, camera at eye level",
};

/** The facings a sheet may be authored for. W is drawn by flipping E. */
export const KEYFRAME_FACINGS = [
  { id: "E", label: "E — right, the authored side" },
  { id: "S", label: "S — toward the camera" },
  { id: "N", label: "N — away from the camera" },
];

const KEYFRAME_MOVES = [
  {
    // FIRST, and not optional in practice: `importedPaints` requires an
    // `idle` clip, and a sheet without one is dropped in SILENCE — the
    // stiltneck shipped for weeks and never once drew for exactly this.
    // Idle keys are small on purpose; a breathing loop that swings as hard
    // as a walk reads as a twitch.
    id: "idle",
    label: "idle keys (required clip)",
    clip: "idle",
    // camera: now CAMERA_BY_DIR[facing]. Set `cameraOverride` to pin one deliberately.
    poses: [
      "standing at rest, weight settled, body at its lowest",
      "breathing in: chest and shoulders lifted, body at its tallest, head slightly raised",
      "standing at rest again, weight settled, a small sway to the other side",
      "breathing out: shoulders dropping, head tilting slightly down",
    ],
  },
  {
    id: "walk",
    label: "walk cycle keys",
    clip: "walk",
    // camera: now CAMERA_BY_DIR[facing]. Set `cameraOverride` to pin one deliberately.
    poses: [
      "right foot planted far forward, left leg trailing behind, body leaning into the step",
      "passing pose: left knee lifted high in front, standing tall on the right foot",
      "left foot planted far forward, right leg trailing behind, body leaning into the step",
      "passing pose: right knee lifted high in front, standing tall on the left foot",
    ],
  },
  {
    id: "run",
    label: "run cycle keys",
    clip: "run",
    // camera: now CAMERA_BY_DIR[facing]. Set `cameraOverride` to pin one deliberately.
    poses: [
      "full sprint stride, right leg extended far forward, left leg kicked back, both feet off the ground",
      "touchdown: right foot landing under the body, left knee driving forward, deep forward lean",
      "full sprint stride mirrored, left leg extended far forward, right leg kicked back, both feet off the ground",
      "touchdown mirrored: left foot landing under the body, right knee driving forward, deep forward lean",
    ],
  },
  {
    id: "attack",
    label: "attack keys",
    clip: "attack",
    // camera: now CAMERA_BY_DIR[facing]. Set `cameraOverride` to pin one deliberately.
    poses: [
      "ready stance, weapon held low and coiled",
      "wind-up: twisted back, weapon raised high behind the head",
      "strike: weapon swung fully forward and extended, body lunging",
      "follow-through: weapon past the target, body unwinding off balance",
    ],
  },
  {
    id: "stumble",
    label: "getting-hit keys",
    clip: "stumble",
    // camera: now CAMERA_BY_DIR[facing]. Set `cameraOverride` to pin one deliberately.
    poses: [
      "upright, flinching as if just struck in the chest",
      "reeling backward, arms flung out, one foot lifting",
      "deep backward lean, almost falling, face turned away",
      "catching balance again, crouched, one hand low for support",
    ],
  },
  {
    /**
     * THE TELEGRAPH, and the reason this list is seven long as of 2026-08-08.
     *
     * `render/tell-clips.ts` resolves the leaper telegraph to the clip
     * `crouch`, and unlike `wake` there is NO painter fallback for it — an
     * unauthored crouch plays `idle` through CLIP_FALLBACK, so the one warning
     * the player has to read fast becomes a monster standing still. It was
     * missing from this list while the animate leg's `defend` preset already
     * authored it, which is the drift `clip-contract.test.ts` now catches.
     *
     * The keys are a HELD pose rather than a movement: the gather is the whole
     * read, so the four keys tighten the same crouch instead of travelling.
     * `anim.crouch` plays at 7fps ≈ 0.43s against LEAP_WINDUP's 0.45s, so a key
     * that wanders is a telegraph that finishes somewhere the pounce does not
     * start from.
     */
    id: "defend",
    label: "defend / telegraph keys (the leaper crouch)",
    clip: "crouch",
    poses: [
      "standing alert, weight settling back, knees just beginning to bend",
      "crouching low, haunches loaded, chest dropped toward the ground",
      "coiled at its lowest, every limb gathered under the body, about to spring",
      "still coiled, head and shoulders angled forward at its target, holding",
    ],
  },
  {
    id: "death",
    label: "death keys",
    clip: "death",
    // camera: now CAMERA_BY_DIR[facing]. Set `cameraOverride` to pin one deliberately.
    poses: [
      "struck hard, arching backward",
      "crumpling, knees buckling under the body",
      "collapsed onto knees, slumping forward",
      "lying flat on the ground, fully collapsed",
    ],
  },
  { id: "custom", label: "custom poses…", clip: "", cameraOverride: "the same view as the reference image", poses: [] },
];

/**
 * The one-click branch: ONE idle frame in, a keyframe sheet per animation
 * category out. Every job reads the SAME init — never the previous sheet —
 * so a row can never inherit another row's drift, and a sheet that already
 * holds four figures can never be mistaken for a character reference.
 * Ordered idle-first because idle is the clip the game refuses to import
 * without.
 */
const KEYFRAME_SET = KEYFRAME_MOVES.filter((m) => m.id !== "custom");

export const MODES = [
  {
    id: "h3",
    title: "minimax h3",
    blurb: "fast candidate video animation leg — 5 frames in ~12s via MiniMax H3 FL2VA Q3_K_M",
    leg: "h3",
    needs: { init: "optional" },
    fields: [
      { id: "preset", label: "action", type: "preset", options: ANIMATE_PRESETS },
      { id: "action", label: "or describe a move", type: "text", placeholder: "jumping, lunging, casting…" },
      { id: "frames", label: "frames", type: "select", options: [{ id: "5", label: "5 frames (fast)" }, { id: "21", label: "21 frames (grid)" }], default: "5" },
      { id: "tiled", label: "VAE mode", type: "select", options: [{ id: "false", label: "Standard (VAEDecode)" }, { id: "true", label: "Tiled (VAEDecodeTiled)" }], default: "false" },
    ],
    etaS: { quality: 12, fast: 12 },
    presets: ANIMATE_PRESETS,
    prompt(params, ctx) {
      const preset = ANIMATE_PRESETS.find((p) => p.id === params.preset);
      const action = String(params.action || preset?.action || "moving");
      return `pix3lwalk, Pixel art game sprite ${action}, smooth looping animation, the character stays centered in frame, consistent colors, plain white background.`;
    },
    build(params, ctx) {
      const asked = Number(params.frames) || 5;
      const length = h3Length(asked);
      return minimaxH3I2V({
        image: ctx.images.init,
        endImage: ctx.images.end ?? null,
        prompt: this.prompt(params, ctx),
        length,
        seed: ctx.seed,
        tiled: params.tiled === "true",
      });
    },
  },
  {
    id: "segment",
    title: "cut out",
    blurb: "lift the subject off ANY background — a photo, a render, a screenshot — in about a second",
    // `leg` is the /free key: a new leg id would unload the 13GB Qwen stack
    // between cutting out and styling, which is exactly the thrash the
    // leg-affinity scheduler exists to prevent. BiRefNet is 444MB and sits
    // beside Qwen on a 24GB card.
    leg: "qwen",
    needs: { init: true },
    fields: [],
    etaS: { quality: 10, fast: 10 },
    prompt() {
      return "background removal (no prompt — this is a segmentation model)";
    },
    build(params, ctx) {
      // The panel's radio decides; fall back to whichever is actually on disk
      // so a box with only Lucida installed still works.
      const pick = ctx.chosen?.("intake-bgremove");
      const model = pick === "lucida" || (!ctx.has("birefnet") && ctx.has("lucida")) ? "lucida" : "birefnet";
      return bgRemove({ image: ctx.images.init, model: `${model}.safetensors` });
    },
  },
  {
    id: "intake-style",
    title: "to pixel art",
    blurb: "the cut-out becomes a sprite — framing is already fixed, so this only changes the LOOK",
    leg: "qwen",
    needs: { init: true, style: "optional" },
    fields: [{ id: "hint", label: "subject (optional)", type: "text", placeholder: "a knight in blue armor…" }],
    etaS: { quality: 260, fast: 100 },
    prompt(params, ctx) {
      // DELIBERATELY NOT asking for "one full-body character, centered, plain
      // white background" the way `pixelize` does. By the time this runs, the
      // reframe has GUARANTEED all three — and asking an edit model to centre
      // an already-centred figure is how it gets moved.
      const hint = params.hint ? ` of ${params.hint}` : "";
      const style = ctx.images.style
        ? " Match the pixel art style, palette and proportions of Figure 2."
        : " 16-bit game sprite style, crisp pixel clusters, hard palette, no anti-aliasing.";
      return `Redraw this character as clean pixel art${hint}, same pose, same size, same position.${style}`;
    },
    build(params, ctx) {
      return qwenEdit({
        image: ctx.images.init,
        image2: ctx.images.style ?? null,
        prompt: this.prompt(params, ctx),
        seed: ctx.seed,
        unet: ctx.unet("rot-unet") ?? undefined,
        ...qwenBundle(ctx),
      });
    },
  },
  {
    id: "rotate",
    title: "rotate",
    blurb: "same character, another facing — the game wants E, S and N",
    leg: "qwen",
    needs: { init: true },
    fields: [
      { id: "facing", label: "facing", type: "select", options: FACINGS.map((f) => ({ id: f.id, label: f.label })), default: "S" },
      { id: "custom", label: "custom angle", type: "text", placeholder: "three-quarter view from the back left…", showIf: { facing: "custom" } },
    ],
    batch: { id: "facings", label: "make all three facings (E + S + N)", values: [{ facing: "E" }, { facing: "S" }, { facing: "N" }] },
    etaS: { quality: 260, fast: 100 },
    prompt(params, ctx) {
      const f = FACINGS.find((x) => x.id === params.facing);
      // The fal angles LoRA replaces freeform turning with a fixed grammar it
      // was trained on; when it is installed the prompt IS the grammar.
      if (ctx.has("fal-multi-angle")) {
        const view = f ? f.sks : String(params.custom ?? "front view");
        return `<sks> ${view} eye-level shot medium shot, plain white background`;
      }
      const dir = f ? f.phrase : String(params.custom ?? "the camera (front view)");
      return (
        `Turn the character to face ${dir}. Same character, same colors, same pixel art style, ` +
        `same size and position, plain white background, full body visible.`
      );
    },
    build(params, ctx) {
      const b = qwenBundle(ctx);
      if (ctx.has("fal-multi-angle")) b.loras.push({ name: ctx.lora("fal-multi-angle"), strength: 0.9 });
      return qwenEdit({
        image: ctx.images.init,
        prompt: this.prompt(params, ctx),
        seed: ctx.seed,
        unet: ctx.unet("rot-unet") ?? undefined,
        ...b,
      });
    },
  },
  {
    id: "animate",
    title: "animate",
    blurb: "one frame in, a motion clip out — pick the frames worth keeping after",
    leg: "wan",
    needs: { init: true },
    fields: [
      { id: "preset", label: "move", type: "select", options: ANIMATE_PRESETS.map((p) => ({ id: p.id, label: p.label })), default: "walk" },
      { id: "action", label: "action (editable)", type: "text", placeholder: "hopping forward / attacking with claws…", prefillFrom: "preset" },
      { id: "frames", label: "frames", type: "select", options: [{ id: "17", label: "17 — short" }, { id: "21", label: "21 — default" }, { id: "33", label: "33 — long" }], default: "21" },
    ],
    // action: "" in every batch entry so the preset's own preprompt wins over
    // whatever the action box holds from the last single run.
    batch: {
      id: "moveset",
      label: `make the full move set (${MOVESET.length} clips)`,
      values: MOVESET.map((p) => ({ preset: p.id, action: "" })),
    },
    etaS: { quality: 450, fast: 90 },
    presets: ANIMATE_PRESETS,
    prompt(params, ctx) {
      const preset = ANIMATE_PRESETS.find((p) => p.id === params.preset);
      const action = String(params.action || preset?.action || "moving");
      // KEYED ON THE CLIP, NOT THE PRESET ID. `walk4` is a walk and must get
      // the walk specialist; an id equality test silently dropped it the moment
      // a second walk preset existed, and a LoRA that loads without its trigger
      // word is the quietest failure there is — the run succeeds and the
      // adapter simply does nothing.
      const isWalk = ANIMATE_PRESETS.find((p) => p.id === params.preset)?.clip === "walk";
      // …AND THE LEG HAS TO BE ABLE TO LOAD IT. `ctx.has()` answers "is this
      // weight on disk", which is a different question from "will this run
      // attach it": the small leg REFUSES every A14B adapter, so on 5B the
      // trigger word went out for a LoRA that was never loaded. Observed on the
      // first real 5B run (2026-08-08) — the prompt read
      // `pix3lwalk, Pixel art game sprite walking…` with no adapter behind it.
      //
      // Looks harmless, is not: a trigger is a token the model was trained to
      // associate with weights that are absent, so it is noise in the
      // conditioning — and it silently contaminates any A/B between the two
      // legs, because the arms would then differ by a PROMPT as well as by a
      // model. Same defect as the id-vs-clip test above, one level out: the
      // LoRA and the word that fires it decided by two different rules.
      const trigger = isWalk && ctx.has("pix3lwalk") && !ctx.small ? "pix3lwalk, " : "";
      // See CYCLE_CLIPS: the looping/centred tail is right for a gait and
      // cancels a one-shot. An unknown clip (a `custom` action) is treated as a
      // cycle, which is the old behaviour and the safer default — telling a
      // gait not to loop costs a seam, telling a lunge to loop costs the lunge.
      const clip = ANIMATE_PRESETS.find((p) => p.id === params.preset)?.clip;
      const tail = !clip || CYCLE_CLIPS.has(clip)
        ? "smooth looping animation, the character stays centered in frame"
        /**
         * ── "STAYS CENTERED IN FRAME" IS LOAD-BEARING. IT STAYS. ────────────
         *
         * This branch used to drop it for one-shots, so a lunge would not be
         * told to stand still. That was reasoned, tested on the attack, and is
         * WRONG — it bought motion by shrinking the dog, and the effect got
         * worse the harder it was pushed. Figure box-area swing, same init,
         * seed 7, one variable at a time:
         *
         *     old tail, "stays centered"                S:attack   7.3%
         *     dropped it                                S:attack  43.9%
         *     dropped it + "stays the same size"        S:attack  62.3%
         *     dropped it                                N:attack  63.5%
         *     dropped it                                E:attack  93.0%   <-- worst
         *
         * The last row is the one that settles it. E is the GOOD facing: E:walk
         * and E:run, which keep the cycle tail, show no scale flag at all. So
         * the receding is not the front/back geometry I first blamed — it
         * followed the PROMPT onto the one facing that has lateral silhouette
         * to spare, and got worse there. Removing that clause was the cause.
         *
         * What survives from the change: one-shots are still not told to LOOP,
         * because a clip that must end elsewhere should not be asked to return
         * to its start. Only the centring is restored. That is one change from
         * a known-good tail rather than two.
         *
         * The cost is honest and unresolved: "stays centered" is also what made
         * the attack inert — the operator's original "it looks like it's just
         * showing its teeth", churn 11% against a walk's 22%. Prompting cannot
         * have both, in either polarity (a size clause made it worse, and Wan's
         * negative already bans shrinking). The lever for an inert one-shot is
         * `--end` keyframes: author the poses and interpolate, rather than
         * asking free-running I2V to invent a lunge. See chapter 13.
         */
        : "one continuous action from start to finish, the character stays centered in frame";
      return `${trigger}Pixel art game sprite ${action}, ${tail}, consistent colors, plain white background.`;
    },
    build(params, ctx) {
      const preset = ANIMATE_PRESETS.find((p) => p.id === params.preset);
      return buildWanClip({
        image: ctx.images.init,
        /**
         * A CYCLE HAS TO CLOSE, and until now nothing asked it to.
         *
         * `wanI2V` has carried the first/last-frame graph since it was written
         * and `animate` never passed an end, so every walk this forge has made
         * free-runs to wherever frame 21 happens to land. Played on a loop that
         * pops: frame 21 does not lead back into frame 1.
         *
         * Pin the SAME image at both ends and the model has to come home. Two
         * things follow for free — Wan's measured 6-8 frame ease-out of the
         * init has somewhere to go, and the whole clip becomes one period of
         * the gait instead of an arbitrary slice of it.
         *
         * The init to hand it is a MID-STRIDE frame, not the standing master:
         * pinning a standing pose at both ends makes the clip stand → walk →
         * stand, which is not a cycle and burns frames at both ends.
         */
        endImage: ctx.images.end ?? null,
        prompt: this.prompt(params, ctx),
        extraNegative: preset?.avoid ?? null,
        length: Number(params.frames) || 21,
        // Same clip test as the trigger above — the LoRA and the word that
        // fires it must never be decided by two different rules. Keyed on the
        // CLIP and not the preset id because `walk4` is a second walk preset
        // (the quadruped four-beat gait) and an id test silently excludes it.
        walk: ANIMATE_PRESETS.find((p) => p.id === params.preset)?.clip === "walk",
        ctx,
      });
    },
  },
  {
    id: "inbetween",
    title: "in-between",
    blurb: "pin the first AND last pose, let the model fill the middle — two rotate/edit keyframes become a move",
    leg: "wan",
    needs: { init: true, end: true },
    fields: [
      { id: "hint", label: "motion hint (optional)", type: "text", placeholder: "raising the sword in one clean arc…" },
      { id: "frames", label: "frames", type: "select", options: [{ id: "17", label: "17 — short" }, { id: "21", label: "21 — default" }], default: "17" },
    ],
    etaS: { quality: 450, fast: 90 },
    prompt(params) {
      const hint = params.hint ? `, ${params.hint}` : "";
      return (
        `Pixel art game sprite moving smoothly from its starting pose to its final pose${hint}, ` +
        `locked-off camera, the character stays the same size and stays centered in frame, ` +
        `consistent colors, plain white background.`
      );
    },
    build(params, ctx) {
      return buildWanClip({
        image: ctx.images.init,
        endImage: ctx.images.end,
        prompt: this.prompt(params, ctx),
        length: Number(params.frames) || 17,
        ctx,
      });
    },
  },
  {
    id: "keyframes",
    title: "keyframes",
    blurb:
      "ONE idle frame in → a sheet of 4 poses per move, denoised together so they can't drift. " +
      "The init must be a single standing character, never a sheet.",
    leg: "qwen",
    needs: { init: true },
    fields: [
      { id: "preset", label: "move", type: "select", options: KEYFRAME_MOVES.map((p) => ({ id: p.id, label: p.label })), default: "walk" },
      // The facing decides the camera for EVERY clip of a sheet. It defaults to
      // E because that is the facing the intake master is framed in — the only
      // one that needs no rotation first.
      { id: "facing", label: "facing (sets the camera)", type: "select", options: KEYFRAME_FACINGS, default: "E" },
      { id: "custom", label: "custom poses (numbered)", type: "text", placeholder: "(1) crouched low (2) leaping (3) mid-air tuck (4) landing…", showIf: { preset: "custom" } },
    ],
    // Every row branches off the SAME idle init — no chaining, so no row can
    // inherit another's drift.
    batch: {
      id: "moveset",
      label: `every move set (${KEYFRAME_SET.length} sheets)`,
      values: KEYFRAME_SET.map((m) => ({ preset: m.id, custom: "" })),
      // NB: a batch is one FACING's move set. A whole character is this batch
      // once per facing, off that facing's own master — which is the planner's
      // job, not a field on this mode.
    },
    etaS: { quality: 260, fast: 100 },
    presets: KEYFRAME_MOVES,
    prompt(params) {
      const move = KEYFRAME_MOVES.find((p) => p.id === params.preset);
      const list = params.preset === "custom" ? String(params.custom ?? "") : move?.poses.map((p, i) => `(${i + 1}) ${p}`).join(", ") ?? "";
      // An explicit per-move override wins; otherwise the FACING decides. A
      // move with neither (only `custom`) inherits the reference image's view.
      const cam =
        move?.cameraOverride ??
        CAMERA_BY_DIR[String(params.facing ?? "E")] ??
        CAMERA_BY_DIR.E;
      // Labels stay OUT of the pixels on purpose: the slicer imports
      // beside-row text as a frame (README), and the row's identity
      // already travels on the job as metadata.
      //
      // The camera sentence is load-bearing, not decoration: without it
      // the model expresses a stride by TURNING the character, and the
      // row comes back as a turnaround instead of a move (measured).
      return (
        `A pixel art sprite sheet: the same character drawn 4 times in a single horizontal row, evenly spaced ` +
        `on a plain white background, identical size and colors in every frame, feet on one shared baseline. ` +
        `Every frame is drawn from the SAME camera angle — ${cam} — the character never turns or rotates ` +
        `between frames, only its pose changes. The four poses, left to right: ${list}. ` +
        // MEASURED 2026-08-05: without this clause the knight's walk row came
        // back at 0.61-0.68x the master's body mass — the model had quietly
        // put his sword away. An edit model asked only for a POSE treats held
        // equipment as scenery it may drop to make the pose read better, and
        // a missing weapon is invisible at thumbnail size while being the
        // whole silhouette in game.
        `The character keeps everything it is wearing and holding in the reference image — ` +
        `weapon, shield, cape, helmet, pack — visible in EVERY frame; nothing is dropped, ` +
        `sheathed, put away or hidden behind the body. ` +
        `Large, clearly different poses — no text, no labels, no numbers in the image.`
      );
    },
    build(params, ctx) {
      return qwenEdit({
        image: ctx.images.init,
        prompt: this.prompt(params, ctx),
        width: 1344,
        height: 768,
        seed: ctx.seed,
        unet: ctx.unet("rot-unet") ?? undefined,
        ...qwenBundle(ctx),
      });
    },
  },
  {
    id: "retarget",
    title: "retarget (pose reference)",
    blurb:
      "SHOW the poses instead of describing them: a reference row in, your character out, same poses. " +
      "Init is the pose row from the library; the style image is your character's approved idle.",
    leg: "qwen",
    // Both are REQUIRED, and that is the whole mode. `keyframes` needs only an
    // init because it describes the poses in words; this one exists precisely
    // because that does not work, so a run without the character to retarget
    // onto would just redraw the reference.
    needs: { init: true, style: true },
    fields: [
      { id: "subject", label: "the character (what Figure 2 is)", type: "text", required: true, placeholder: "a hooded skeleton archer…" },
    ],
    etaS: { quality: 260, fast: 100 },
    prompt(params) {
      const subject = String(params.subject ?? "").trim().replace(/\.$/, "");
      // FIGURE 1 IS THE POSES, FIGURE 2 IS THE IDENTITY, and saying which is
      // which is load-bearing — the edit model will happily return Figure 2
      // standing still if the instruction leaves the roles ambiguous.
      //
      // The count and layout are asserted rather than requested: the reference
      // already HAS them, so this is describing the image the model is looking
      // at, which it follows far more reliably than a target it must invent.
      return (
        `Figure 1 is a pixel art pose reference: one character drawn several times in a row, ` +
        `each frame a different pose, all from the same camera angle. ` +
        `Redraw that ENTIRE row as ${subject} — the character in Figure 2 — matching Figure 1 ` +
        `pose for pose, frame for frame, in the same order, at the same size and spacing, ` +
        `feet on the same shared baseline, on a plain white background. ` +
        `Keep Figure 2's colours, proportions and equipment in every frame; ` +
        `keep Figure 1's poses, framing and facing direction exactly. ` +
        `The character faces the same way as Figure 1 in every frame and never turns between frames. ` +
        `No text, no labels, no numbers in the image.`
      );
    },
    build(params, ctx) {
      // ⚠️ THE CANVAS SHAPE IS LOAD-BEARING, MEASURED 2026-08-06.
      //
      // Built without width/height first, so it took the square default — and a
      // 3-pose row asked for on a 1:1 canvas came back as a 3x3 GRID, nine cells
      // of which three were the character and the rest invented quadrupeds to
      // fill the space. The poses were correctly DIFFERENT (the whole point),
      // but the layout was unusable.
      //
      // An edit model lays out to fill what it is given, so the canvas has to
      // carry the same aspect as the reference row. `keyframes` learnt this and
      // hardcodes 1344x768 for its 4-up; a retarget row can be any length, so
      // the caller passes the reference's own shape and this only supplies the
      // wide default.
      const width = Number(params.width) || 1344;
      const height = Number(params.height) || 768;
      return qwenEdit({
        image: ctx.images.init,
        image2: ctx.images.style,
        prompt: this.prompt(params, ctx),
        width,
        height,
        seed: ctx.seed,
        unet: ctx.unet("rot-unet") ?? undefined,
        ...qwenBundle(ctx),
      });
    },
  },
  {
    id: "edit",
    title: "edit",
    blurb: "free instruction over the whole frame — pose tweaks, gear swaps, cleanup",
    leg: "qwen",
    needs: { init: true, style: "optional" },
    fields: [{ id: "prompt", label: "instruction", type: "text", required: true, placeholder: "raise both arms overhead / give him a torch…" }],
    etaS: { quality: 260, fast: 100 },
    prompt(params, ctx) {
      const base = String(params.prompt ?? "").trim().replace(/\.?$/, ".");
      return ctx.images.style ? `${base} Keep the pixel art style of Figure 2.` : base;
    },
    build(params, ctx) {
      return qwenEdit({
        image: ctx.images.init,
        image2: ctx.images.style ?? null,
        prompt: this.prompt(params, ctx),
        seed: ctx.seed,
        unet: ctx.unet("rot-unet") ?? undefined,
        ...qwenBundle(ctx),
      });
    },
  },
  {
    id: "touchup",
    title: "touch-up",
    blurb: "brush over the wrong part, say what belongs there — everything outside the brush is untouched",
    leg: "qwen",
    needs: { init: true, mask: true },
    fields: [{ id: "prompt", label: "what should be there", type: "text", required: true, placeholder: "a gauntleted hand gripping the sword…" }],
    etaS: { quality: 260, fast: 100 },
    prompt(params) {
      return String(params.prompt ?? "");
    },
    build(params, ctx) {
      return qwenInpaint({
        image: ctx.images.init,
        mask: ctx.images.mask,
        prompt: this.prompt(params, ctx),
        seed: ctx.seed,
        unet: ctx.unet("rot-unet") ?? undefined,
        ...qwenBundle(ctx),
      });
    },
  },
  {
    id: "pixelize",
    title: "pixelize",
    blurb: "any image — photo, render, drawing — into a clean sprite-style frame; add a committed sheet as the style to match",
    leg: "qwen",
    needs: { init: true, style: "optional" },
    fields: [{ id: "hint", label: "subject (optional)", type: "text", placeholder: "a knight in blue armor…" }],
    etaS: { quality: 260, fast: 100 },
    prompt(params, ctx) {
      const hint = params.hint ? ` of ${params.hint}` : "";
      const style = ctx.images.style
        ? " Match the pixel art style, palette and proportions of Figure 2."
        : " 16-bit game sprite style, crisp pixel clusters, hard palette.";
      return (
        `Convert this image into clean pixel art${hint}: one full-body game character on a plain ` +
        `white background, centered.${style}`
      );
    },
    build(params, ctx) {
      return qwenEdit({
        image: ctx.images.init,
        image2: ctx.images.style ?? null,
        prompt: this.prompt(params, ctx),
        seed: ctx.seed,
        unet: ctx.unet("rot-unet") ?? undefined,
        ...qwenBundle(ctx),
      });
    },
  },
];

export function modeById(id) {
  return MODES.find((m) => m.id === id) ?? null;
}

/**
 * The panel's view of the registry: fields and availability, no builders.
 * `has` decides fast-mode availability and which advisory notes show, so
 * the UI can say "style lock riding along" without knowing LoRA filenames.
 */
export function serializeModes(has) {
  return MODES.map((m) => ({
    id: m.id,
    title: m.title,
    blurb: m.blurb,
    leg: m.leg,
    needs: m.needs,
    fields: m.fields,
    batch: m.batch ?? null,
    presets: m.presets ?? null,
    etaS: m.etaS,
    fastAvailable: fastAvailable(m.leg, has),
    // `inbetween` is excluded on purpose rather than by omission: the 5B latent
    // node has no `end_image`, so offering the small leg there would advertise
    // a control the executor cannot honour.
    smallAvailable: m.id !== "inbetween" && smallAvailable(m.leg, has),
    notes: [
      m.leg === "qwen" && has("tarn59-pixel-style") ? "pixel style lock riding along" : null,
      m.leg === "qwen" && m.id === "rotate" && has("fal-multi-angle") ? "deterministic angle grammar active" : null,
      m.leg === "wan" && has("styly-pixel-animate") ? "pixel motion adapter riding along" : null,
      m.id === "animate" && has("pix3lwalk") ? "walk preset uses the pix3lwalk specialist" : null,
      // Gated on the PER-MODE availability, not the leg's. Keyed on the leg it
      // advertised the small option on `inbetween` — which cannot use it — and
      // then contradicted itself on the next line. A panel that offers a
      // control the executor will refuse is worse than one that offers nothing.
      m.leg === "wan" && m.id !== "inbetween" && smallAvailable(m.leg, has)
        ? "small leg (TI2V-5B) available — 13.6GB of reads instead of 31, and NO pixel LoRAs"
        : null,
      m.id === "inbetween" && smallAvailable(m.leg, has) ? "A14B only — 5B cannot pin a last frame" : null,
    ].filter(Boolean),
  }));
}
