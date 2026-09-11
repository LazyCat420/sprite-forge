/**
 * API-format graph builders — the two legs of the sprite pipeline.
 *
 * A ComfyUI "API format" graph is {id: {class_type, inputs}} with cross-node
 * references as ["otherId", outputIndex]. These builders are the ONLY place
 * node class names appear; cli.mjs runs client.assertNodes() before queueing
 * so a renamed node fails with its name, not an opaque 400.
 *
 * Model filenames are pinned here to what setup downloaded into
 * ~/comfy/ComfyUI/models — see README.md. Override per call if a model is
 * re-quantized; do not silently rename files on disk.
 *
 * ── WHY THE OUTPUT IS NOT PIXEL ART ──────────────────────────────────────
 * Both legs return soft ~512-1024px renderings ON PURPOSE. No open model
 * emits a true pixel grid; the pipeline's contract is: generate large, then
 * let sprite-forge's own reduce + palette snap make it pixel art. Keeping
 * that step in sprite-forge (not a server node) means imported sheets and
 * generated sheets go through ONE canonical crush. Feed outputs to the
 * inbox exactly like any other generated sheet.
 */

export const MODELS = {
  qwenUnet: "qwen-image-edit-2511-Q4_K_M.gguf",
  qwenClip: "qwen_2.5_vl_7b_fp8_scaled.safetensors",
  qwenVae: "qwen_image_vae.safetensors",
  wanHigh: "Wan2.2-I2V-A14B-HighNoise-Q6_K.gguf",
  wanLow: "Wan2.2-I2V-A14B-LowNoise-Q6_K.gguf",
  wanClip: "umt5_xxl_fp8_e4m3fn_scaled.safetensors",
  wanVae: "wan_2.1_vae.safetensors",
  /**
   * THE SMALL ANIMATION LEG — one dense 5B model instead of two 12GB experts.
   *
   * Same family, same text encoder, DIFFERENT VAE: the 2.2 VAE compresses 16×
   * spatially where the 2.1 VAE compresses 8×, which is why it has its own
   * latent node (`Wan22ImageToVideoLatent`, `height // 16`) and why pairing 5B
   * with `wan_2.1_vae` would decode to garbage rather than error.
   */
  wanSmall: "Wan2.2-TI2V-5B-Q8_0.gguf",
  wanVae22: "wan2.2_vae.safetensors",
  pixelWalkLoraHigh: "pixel_walk_lora_v1_high_noise.safetensors",
  qwenControlNet: "qwen_image_controlnet_union.safetensors",
  /**
   * THE CANDIDATE ANIMATION LEG — MiniMax H3, under test (chapter 14).
   *
   * One model where Wan is two experts, which is the whole reason it is being
   * measured: Wan's ~30GB peak is both experts resident at once, and a single
   * model that can free its encoder before loading the unet may peak lower on
   * the same box. Nothing here is adopted until the five acceptance criteria
   * in chapter 14 all hold.
   *
   * The encoder is deliberately NOT a GGUF. `comfy/text_encoders/minimax.py`
   * calls `self.visual(...)` on the keyframe path, so the vision tower is
   * mandatory for fl2va — and every community GGUF encoder splits it into a
   * separate mmproj file that needs a FORK of ComfyUI-GGUF to reassemble.
   * The official nvfp4 file carries the tower in one piece. nvfp4 compute
   * needs Blackwell (`supports_nvfp4_compute` wants `props.major >= 10`); on
   * this sm_86 card ComfyUI puts it in "emulated ops", so the weights stay
   * packed at 15.7GB and dequant happens per-matmul. Slower, not fatal — and
   * memory, not speed, is the question this leg exists to answer.
   */
  h3Unet: "MiniMax-H3-FL2VA-Pruned-Q3_K_M.gguf",
  h3Clip: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
  h3Vae: "minimax_h3_video_vae_fp16.safetensors",
};

/**
 * H3's frame grid: 17k+5 at 24fps, per `align_frame_count` in
 * comfy_extras/nodes_minimax_h3.py. 5 is the floor and the cheapest possible
 * ask; the next rung is 22, then 39. Wan's 4k+1 grid does not apply here and
 * a length off this grid is silently rounded UP, which would make a
 * frame-count comparison against Wan measure the wrong clip.
 */
export function h3Length(n) {
  let f = Math.max(5, Math.round(n));
  while (f % 17 !== 5) f += 1;
  return f;
}

/**
 * CONTROL TYPE → the preprocessor node that turns a reference into a map.
 *
 * ⚠️ THE CHOICE HERE IS THE WHOLE POINT, not a quality knob. `POSE_IS_THE_LATENT.md`
 * measured that pose and silhouette are the SAME low-frequency signal in this
 * graph's latent, so nothing that carries an outline can move one without the
 * other. That is a statement about what the control map CONTAINS:
 *
 *   openpose  a STICK SKELETON — joints and limb vectors, no body width at
 *             all. The only map here that constrains where the limbs are
 *             without also constraining how wide the body is, which is
 *             precisely the separation the denoise dial could not make.
 *   canny     EDGES — the full outline of whatever body is in the reference.
 *             Feed it a human and the ControlNet holds the sampler to a
 *             HUMAN'S proportions; a brute prompt returns a correctly-posed
 *             skinny figure. This is the doc's runs 2-5 arriving through a
 *             new door, so canny is here to be BEATEN in the A/B, not used.
 *   lineart   softer edges, same objection as canny, kept for the comparison.
 *   depth     volume without identity — worth a column in the same A/B.
 *
 * So: openpose is the hypothesis, the rest are the controls it has to beat.
 */
export const CONTROL_PREPROCESSORS = {
  openpose: { node: "OpenposePreprocessor", inputs: { detect_hand: "enable", detect_body: "enable", detect_face: "disable" } },
  canny: { node: "CannyEdgePreprocessor", inputs: {} },
  lineart: { node: "LineArtPreprocessor", inputs: {} },
  depth: { node: "DepthAnythingV2Preprocessor", inputs: {} },
  /** The reference IS already a control map (a hand-drawn skeleton, a depth pass). */
  raw: null,
};

/**
 * Just the control map, so it can be LOOKED AT before any sampling is paid for.
 *
 * A pose map is the one input in this pipeline whose failure is invisible
 * downstream: an openpose pass that finds no skeleton returns a BLACK frame,
 * ControlNet then conditions on nothing, and the result is indistinguishable
 * from "ControlNet does not help" — which is how a mechanism gets wrongly
 * abandoned. Render it first; a black map is a missing detection, not a
 * verdict on the mechanism.
 */
export function controlMap({ image, type = "openpose", resolution = 1024 } = {}) {
  if (!image) throw new Error("[graphs] controlMap needs an uploaded image name");
  const p = CONTROL_PREPROCESSORS[type];
  if (!p) throw new Error(`[graphs] controlMap has no preprocessor for "${type}"`);
  return {
    img: { class_type: "LoadImage", inputs: { image } },
    pre: { class_type: p.node, inputs: { image: ["img", 0], resolution, ...p.inputs } },
    out: { class_type: "SaveImage", inputs: { images: ["pre", 0], filename_prefix: "spriteforge/control" } },
  };
}

/**
 * THE WAN NEGATIVE — shared by both animation legs, because it is a statement
 * about what Wan does rather than about which quant is loaded.
 *
 * Camera terms are in the negative because Wan is a VIDEO model: trained on
 * footage where the camera lives, it treats a locked-off shot as boring and
 * adds a slow push-in. A sprite clip needs the opposite — the character moves,
 * the frame never does.
 *
 * ── THE BACKGROUND TERMS ARE THE SAME ARGUMENT, MEASURED ────────────────────
 *
 * Wan free-runs a SCENE from frame 0, and the background is part of the scene.
 * "plain white background" sits in the POSITIVE prompt, where it is one clause
 * among many and loses to the action's own semantics — "dying" reads as dark.
 * Measured 2026-08-06 across five 21-frame clips off one master: idle and
 * attack settled light and were usable; the walk carrying the pix3lwalk LoRA
 * and BOTH death runs drove the field to black.
 *
 * A black field is not merely ugly, it is UNKEYABLE. `matte()` floods from the
 * border and stops at the first outline it meets; when the creature's own
 * outlines are black on black there is no boundary, the fill walks into the
 * body, and the frame arrives as 13%-tall fragments. That is the whole of why
 * 0 of 21 walk frames survived while 15 of 21 attack frames did.
 *
 * The smoke/glow terms are from the same run: both death clips dissolved the
 * figure into particle VFX, which a sprite would bake in permanently.
 */
export const WAN_NEGATIVE =
  "static, frozen, watermark, text, extra character, split screen, " +
  "camera zoom, zoom in, zoom out, dolly, camera pan, camera movement, " +
  "changing scale, character growing, character shrinking, cropped body, " +
  "dark background, black background, changing background, night, shadows, " +
  "vignette, fog, smoke, glow, particles, sparks, motion blur";

/**
 * LoRA filename fragments that are keyed to the A14B two-expert architecture
 * and therefore cannot load on TI2V-5B.
 *
 * Matched on a FRAGMENT rather than the full filename on purpose: these arrive
 * from the manifest, and a quant swap or a re-download under a slightly
 * different name must not quietly turn the guard off. A guard that only fires
 * on an exact string is a guard that stops firing the first time someone
 * renames a file.
 */
export const A14B_ONLY_LORAS = ["pixel_animate", "pixel_walk", "lightning_i2v"];

/**
 * Attach a stack of LoRAs between a unet loader and whatever samples from it.
 * Returns the model ref the sampler should take. Order is the caller's chain
 * discipline: on the Wan leg the ModelSamplingSD3 shift must wrap the LAST
 * lora (see wanI2V); on the Qwen leg the sampler takes this ref directly.
 */
function chainLoras(g, modelRef, loras, prefix) {
  let model = modelRef;
  for (let i = 0; i < (loras?.length ?? 0); i++) {
    const l = loras[i];
    g[`${prefix}${i}`] = {
      class_type: "LoraLoaderModelOnly",
      inputs: { model, lora_name: l.name, strength_model: l.strength ?? 0.8 },
    };
    model = [`${prefix}${i}`, 0];
  }
  return model;
}

/**
 * BACKGROUND REMOVAL — the step that makes "any image" true.
 *
 * Everything downstream assumes a single figure on a keyable field, and until
 * now that was a sentence in a prompt rather than a step: `matte.ts` hard-fails
 * unless 90% of the border band is one colour, so a photograph was rejected
 * before the pipeline began.
 *
 * These are CORE ComfyUI nodes (Comfy-Org/ComfyUI#12747) — no custom node, and
 * no GPL dependency. Only the weight is a download.
 *
 * ⚠️ THE InvertMask IS LOAD-BEARING. `RemoveBackground` returns a FOREGROUND
 * mask (1 = subject) while core's `JoinImageWithAlpha` computes
 * `alpha = 1 - mask`. Wire them together directly and you get an image that is
 * transparent exactly where the character is.
 *
 * Both outputs are saved on purpose: the RGBA cutout is what the next stage
 * reframes, and the raw mask is what QA measures and the brush edits — reading
 * a mask back out of premultiplied alpha loses its hard edges.
 */
export function bgRemove({ image, model = "birefnet.safetensors" } = {}) {
  if (!image) throw new Error("[graphs] bgRemove needs an uploaded image name");
  return {
    bg: { class_type: "LoadBackgroundRemovalModel", inputs: { bg_removal_name: model } },
    img: { class_type: "LoadImage", inputs: { image } },
    m: { class_type: "RemoveBackground", inputs: { bg_removal_model: ["bg", 0], image: ["img", 0] } },
    inv: { class_type: "InvertMask", inputs: { mask: ["m", 0] } },
    rgba: { class_type: "JoinImageWithAlpha", inputs: { image: ["img", 0], alpha: ["inv", 0] } },
    cut: { class_type: "SaveImage", inputs: { images: ["rgba", 0], filename_prefix: "spriteforge/intake_cut" } },
    mi: { class_type: "MaskToImage", inputs: { mask: ["m", 0] } },
    msk: { class_type: "SaveImage", inputs: { images: ["mi", 0], filename_prefix: "spriteforge/intake_mask" } },
  };
}

/**
 * Qwen-Image-Edit: one init image + an instruction → an edited image with
 * the character preserved. This is the rotation / pose-keyframe leg.
 *
 * TextEncodeQwenImageEditPlus is the 2509+ conditioning node: it takes the
 * reference image(s) alongside the prompt, which is what holds identity —
 * plain img2img denoise does not. It accepts up to three references;
 * `image2`/`image3` are how a style ref (e.g. a committed sheet) rides along
 * with the content image — the prompt then addresses them as "Figure 2" etc.
 *
 * `loras` is [{name, strength}] stacked model-only between the unet and the
 * sampler — the style lock, the angles grammar, and the Lightning distill
 * all attach here. Lightning changes the OPERATING POINT, not just speed:
 * callers that attach it must also pass its coupled steps/cfg (modes.mjs
 * owns those bundles; do not scatter them).
 */
/**
 * THE SHARED QWEN NEGATIVE.
 *
 * ── WHY IT BANS A GROUND SHADOW (2026-08-07) ────────────────────────────────
 *
 * The brute's restyled master came back standing on a soft lavender ellipse.
 * Every positive prompt in `modes.mjs` asks for a "plain white background" and
 * the model obliged — a cast shadow is not background, it is the subject's
 * shadow, so nothing in the prompt forbade it.
 *
 * It is not cosmetic. Three things downstream take the silhouette as ground
 * truth and all three are wrong with a shadow attached:
 *
 *   · `bbox()` in prep — the ellipse is wider than the figure, so every frame's
 *     bbox is the shadow's, and the ONE-SCALE-ONE-BASELINE rule then sizes the
 *     creature off it.
 *   · `matte()` — a soft-edged gradient against white is the worst case for a
 *     flood key; it leaves a fringe rather than a clean silhouette.
 *   · frame SCORING — measured on the 21-frame walk clip: leg-stance spread
 *     came back 227-242px for all 21 frames, because the constant shadow
 *     dominated the band the measurement samples. A curation metric that
 *     cannot see the legs cannot pick a walk cycle.
 *
 * Fixed in the NEGATIVE rather than in each mode's positive, deliberately. The
 * `rotate` mode's prompt becomes a fixed `<sks> … eye-level shot medium shot`
 * grammar when `fal-multi-angle` is installed — that grammar is what the LoRA
 * was trained on and appending clauses to it is how it stops binding. One
 * negative covers style, rotate, keyframes, edit, pixelize and touchup at once.
 *
 * Same shape as the fix `4823ec7` made to the Wan negative, which already bans
 * `shadows` for exactly the same reason on the other leg.
 */
const QWEN_NEGATIVE =
  "blurry, deformed, extra limbs, watermark, text, " +
  "cast shadow, drop shadow, ground shadow, shadow under the character, " +
  "reflection, floor, ground plane, platform, pedestal";

/**
 * TEXT → IMAGE. No init, no conditioning image, nothing to restyle.
 *
 * ── WHY THIS IS POSSIBLE WITH THE MODELS ALREADY ON THE SHELF ───────────────
 *
 * `PLAN_KEYFRAME_PIPELINE.md` calls step 1 the one real gap, and the reason
 * looked like a missing model: `models/unet/` holds Qwen-Image-**Edit** and two
 * Wan **I2V** experts, `checkpoints/` and `diffusion_models/` are empty, and
 * every entry in MODES declares `needs.init`. The conclusion drawn from that —
 * that a ~15GB base-model download was required — was WRONG.
 *
 * Qwen-Image-Edit is Qwen-Image with image conditioning bolted on. The
 * transformer underneath is a text-to-image model; the edit variant reaches it
 * through `TextEncodeQwenImageEditPlus`, which is what binds a source image
 * into the conditioning. Encode the prompt with a PLAIN `CLIPTextEncode`
 * instead, start from the `EmptySD3LatentImage` this file already builds, and
 * the same weights generate from text alone. Nothing is downloaded and nothing
 * about the edit path changes.
 *
 * ── WHAT IT IS FOR ──────────────────────────────────────────────────────────
 *
 * The master. Everything downstream of it — keyframes, in-betweens, rotation,
 * animation — is conditioned on art this pipeline made, at the size it ships
 * at. That is the whole point of the keyframe plan and the opposite of seeding
 * a character from a photo, a painter's render or somebody else's sprite.
 *
 * The style LoRAs matter MORE here than anywhere else in the forge: this is the
 * one generation with no init to inherit a look from, so `tarn59-pixel-style`
 * is carrying the entire style decision. Pass it in `loras` — the caller's
 * `ctx` already resolves it, exactly as the edit leg does.
 */
export function qwenText2Image({
  prompt,
  negative = QWEN_NEGATIVE,
  width = 1024,
  height = 1024,
  seed = 7,
  steps = 20,
  cfg = 2.5,
  loras = [],
  unet = MODELS.qwenUnet,
} = {}) {
  if (!prompt) throw new Error("[graphs] qwenText2Image needs a prompt");
  const g = {
    u: { class_type: "UnetLoaderGGUF", inputs: { unet_name: unet } },
    c: { class_type: "CLIPLoader", inputs: { clip_name: MODELS.qwenClip, type: "qwen_image", device: "default" } },
    v: { class_type: "VAELoader", inputs: { vae_name: MODELS.qwenVae } },
    // PLAIN text encode — no `image1`, which is the single difference from the
    // edit leg and the reason this needs no init.
    pos: { class_type: "CLIPTextEncode", inputs: { clip: ["c", 0], text: prompt } },
    neg: { class_type: "CLIPTextEncode", inputs: { clip: ["c", 0], text: negative } },
    lat: { class_type: "EmptySD3LatentImage", inputs: { width, height, batch_size: 1 } },
    k: {
      class_type: "KSampler",
      inputs: {
        model: ["u", 0], positive: ["pos", 0], negative: ["neg", 0], latent_image: ["lat", 0],
        seed, steps, cfg, sampler_name: "euler", scheduler: "simple", denoise: 1,
      },
    },
    dec: { class_type: "VAEDecode", inputs: { samples: ["k", 0], vae: ["v", 0] } },
    out: { class_type: "SaveImage", inputs: { images: ["dec", 0], filename_prefix: "spriteforge/create" } },
  };
  g.k.inputs.model = chainLoras(g, ["u", 0], loras, "l");
  return g;
}

export function qwenEdit({
  image,
  image2 = null,
  image3 = null,
  prompt,
  negative = QWEN_NEGATIVE,
  width = 1024,
  height = 1024,
  seed = 7,
  steps = 20,
  cfg = 2.5,
  loras = [],
  unet = MODELS.qwenUnet,
  /** <1 switches the sampler to a LATENT init — see the structure leg below. */
  denoise = 1,
  /** Uploaded image the pose comes FROM. See the CONTROL leg at the bottom. */
  control = null,
  /** Which map to derive from it — `CONTROL_PREPROCESSORS`. */
  controlType = "openpose",
  controlStrength = 0.8,
  /** Release the constraint before the end so the surface is free to restyle. */
  controlStart = 0,
  controlEnd = 0.8,
} = {}) {
  if (!image) throw new Error("[graphs] qwenEdit needs an uploaded image name");
  if (!prompt) throw new Error("[graphs] qwenEdit needs a prompt");
  const g = {
    u: { class_type: "UnetLoaderGGUF", inputs: { unet_name: unet } },
    c: { class_type: "CLIPLoader", inputs: { clip_name: MODELS.qwenClip, type: "qwen_image", device: "default" } },
    v: { class_type: "VAELoader", inputs: { vae_name: MODELS.qwenVae } },
    img: { class_type: "LoadImage", inputs: { image } },
    pos: {
      class_type: "TextEncodeQwenImageEditPlus",
      inputs: { clip: ["c", 0], vae: ["v", 0], image1: ["img", 0], prompt },
    },
    neg: {
      class_type: "TextEncodeQwenImageEditPlus",
      inputs: { clip: ["c", 0], vae: ["v", 0], image1: ["img", 0], prompt: negative },
    },
    lat: { class_type: "EmptySD3LatentImage", inputs: { width, height, batch_size: 1 } },
    k: {
      class_type: "KSampler",
      inputs: {
        model: ["u", 0], positive: ["pos", 0], negative: ["neg", 0], latent_image: ["lat", 0],
        seed, steps, cfg, sampler_name: "euler", scheduler: "simple", denoise: 1,
      },
    },
    dec: { class_type: "VAEDecode", inputs: { samples: ["k", 0], vae: ["v", 0] } },
    out: { class_type: "SaveImage", inputs: { images: ["dec", 0], filename_prefix: "spriteforge/qwen" } },
  };
  // Extra references feed BOTH encoders — asymmetric refs would make the
  // negative conditioning contradict the positive on what the images mean.
  if (image2) {
    g.img2 = { class_type: "LoadImage", inputs: { image: image2 } };
    g.pos.inputs.image2 = ["img2", 0];
    g.neg.inputs.image2 = ["img2", 0];
  }
  if (image3) {
    g.img3 = { class_type: "LoadImage", inputs: { image: image3 } };
    g.pos.inputs.image3 = ["img3", 0];
    g.neg.inputs.image3 = ["img3", 0];
  }
  // STRUCTURE LEG. Everything above hands the init to the model as
  // CONDITIONING only — the sampler still starts from `EmptySD3LatentImage` at
  // denoise 1, so nothing about the init's geometry is binding. That is why
  // pose is lost three different ways (measured): from a second reference
  // image (`retarget`), from a sentence (`keyframes`), and even from editing
  // the very row the poses are drawn in.
  //
  // Encoding the init INTO the latent and denoising partially is the other
  // lever: structure comes from where the sampler starts, identity keeps
  // coming from the conditioning above. The header's "plain img2img denoise
  // does not [hold identity]" is an argument against using this ALONE, not
  // against combining it with the edit conditioning.
  //
  // Scaled to the requested canvas first — with a latent init the canvas is
  // the LATENT's size, so an unscaled encode silently ignores width/height.
  if (denoise < 1) {
    g.scl = {
      class_type: "ImageScale",
      inputs: { image: ["img", 0], width, height, upscale_method: "nearest-exact", crop: "disabled" },
    };
    g.enc = { class_type: "VAEEncode", inputs: { pixels: ["scl", 0], vae: ["v", 0] } };
    g.k.inputs.latent_image = ["enc", 0];
    g.k.inputs.denoise = denoise;
    delete g.lat;
  }
  // ── THE CONTROL LEG: THE ONLY THING HERE THE SAMPLER IS BOUND TO ─────────
  //
  // Everything above reaches the sampler as CONDITIONING (images 1-3) or as a
  // starting point it is free to leave (the denoise latent). `POSE_IS_THE_LATENT.md`
  // spent six runs proving neither holds a pose you can also restyle:
  //
  //   denoise 1.0  → the latent is discarded; pose lost, body rebuilt
  //   denoise <1   → the latent is re-rendered; pose kept, body kept too
  //
  // and concluded there is no value in between, because pose and silhouette
  // are ONE signal there. Its closing line names this leg as the mechanism
  // left standing: structural conditioning applied to the CONDITIONING PAIR,
  // which ControlNet re-injects at every sampling step. The sampler cannot
  // walk away from it the way it walks away from a latent — and with an
  // openpose map, what it cannot walk away from is a SKELETON, which says
  // where the limbs go and nothing at all about how wide the body is.
  //
  // BOTH conditionings go through. Applying to the positive alone lets the
  // negative disagree about where the figure is, which shows up as a doubled
  // or smeared limb. The VAE is wired in because Qwen's ControlNet-Union is a
  // latent-space controlnet and `ControlNetApplyAdvanced` takes a vae as an
  // optional input for exactly that case.
  //
  // `controlEnd` below 1 releases the constraint for the last fraction of
  // sampling so the surface (flesh, rot, pixel clusters) can resolve without
  // the map's edges printing through. 0.8 is a STARTING POINT, not a measured
  // value — it is one of the axes the A/B has to sweep before this is trusted,
  // which the manifest note and the doc both insist on.
  if (control) {
    const p = CONTROL_PREPROCESSORS[controlType];
    if (p === undefined) throw new Error(`[graphs] unknown controlType "${controlType}"`);
    g.cimg = { class_type: "LoadImage", inputs: { image: control } };
    let mapRef = ["cimg", 0];
    // `raw` means the caller already HAS a control map, and preprocessing it
    // again would be a second opinion about a picture that is already answer.
    if (p) {
      g.cpre = {
        class_type: p.node,
        inputs: { image: ["cimg", 0], resolution: Math.max(width, height), ...p.inputs },
      };
      mapRef = ["cpre", 0];
    }
    g.cnet = { class_type: "ControlNetLoader", inputs: { control_net_name: MODELS.qwenControlNet } };
    g.cna = {
      class_type: "ControlNetApplyAdvanced",
      inputs: {
        positive: ["pos", 0],
        negative: ["neg", 0],
        control_net: ["cnet", 0],
        image: mapRef,
        vae: ["v", 0],
        strength: controlStrength,
        start_percent: controlStart,
        end_percent: controlEnd,
      },
    };
    g.k.inputs.positive = ["cna", 0];
    g.k.inputs.negative = ["cna", 1];
  }
  g.k.inputs.model = chainLoras(g, ["u", 0], loras, "l");
  return g;
}

/**
 * Qwen-Image-Edit, but only inside a mask: brush over the wrong hand, say
 * what should be there, keep every other pixel byte-identical.
 *
 * SetLatentNoiseMask confines the sampler's noise to the masked latents; the
 * conditioning still sees the WHOLE clean init through image1, which is what
 * keeps the untouched region's identity flowing into the regenerated patch.
 * The final ImageCompositeMasked guarantees the unmasked area is the source
 * pixels, not a VAE round-trip of them — a crush-bound frame cannot afford
 * even one lossy re-encode outside the brush.
 *
 * `mask` is an uploaded grayscale PNG: white = regenerate, black = keep.
 */
export function qwenInpaint({
  image,
  mask,
  prompt,
  negative = QWEN_NEGATIVE,
  seed = 7,
  steps = 20,
  cfg = 2.5,
  loras = [],
  unet = MODELS.qwenUnet,
} = {}) {
  if (!image) throw new Error("[graphs] qwenInpaint needs an uploaded image name");
  if (!mask) throw new Error("[graphs] qwenInpaint needs an uploaded mask image name");
  if (!prompt) throw new Error("[graphs] qwenInpaint needs a prompt");
  const g = {
    u: { class_type: "UnetLoaderGGUF", inputs: { unet_name: unet } },
    c: { class_type: "CLIPLoader", inputs: { clip_name: MODELS.qwenClip, type: "qwen_image", device: "default" } },
    v: { class_type: "VAELoader", inputs: { vae_name: MODELS.qwenVae } },
    img: { class_type: "LoadImage", inputs: { image } },
    mimg: { class_type: "LoadImage", inputs: { image: mask } },
    m: { class_type: "ImageToMask", inputs: { image: ["mimg", 0], channel: "red" } },
    enc: { class_type: "VAEEncode", inputs: { pixels: ["img", 0], vae: ["v", 0] } },
    nm: { class_type: "SetLatentNoiseMask", inputs: { samples: ["enc", 0], mask: ["m", 0] } },
    pos: {
      class_type: "TextEncodeQwenImageEditPlus",
      inputs: { clip: ["c", 0], vae: ["v", 0], image1: ["img", 0], prompt },
    },
    neg: {
      class_type: "TextEncodeQwenImageEditPlus",
      inputs: { clip: ["c", 0], vae: ["v", 0], image1: ["img", 0], prompt: negative },
    },
    k: {
      class_type: "KSampler",
      inputs: {
        model: ["u", 0], positive: ["pos", 0], negative: ["neg", 0], latent_image: ["nm", 0],
        seed, steps, cfg, sampler_name: "euler", scheduler: "simple", denoise: 1,
      },
    },
    dec: { class_type: "VAEDecode", inputs: { samples: ["k", 0], vae: ["v", 0] } },
    comp: {
      class_type: "ImageCompositeMasked",
      inputs: { destination: ["img", 0], source: ["dec", 0], x: 0, y: 0, resize_source: false, mask: ["m", 0] },
    },
    out: { class_type: "SaveImage", inputs: { images: ["comp", 0], filename_prefix: "spriteforge/inpaint" } },
  };
  g.k.inputs.model = chainLoras(g, ["u", 0], loras, "l");
  return g;
}

/**
 * Wan 2.2 I2V: one init frame → a short motion clip, decoded as a BATCH of
 * PNG frames (SaveImage writes each batch item separately — which is
 * exactly what a sprite sheet wants; no video container involved).
 *
 * Two-expert MoE: the high-noise unet takes the first half of the steps,
 * the low-noise unet finishes. LoRAs attach per-expert; the pix3lwalk
 * community LoRA ships a high-noise half only — attaching it low too would
 * double-style the refinement, so each side is optional and independent.
 * `lorasHigh`/`lorasLow` are stacked [{name, strength}] arrays; the old
 * single loraHigh/loraLow spelling is still accepted.
 *
 * `endImage` turns this into the native first/last-frame graph: the same
 * experts, the same conditioning, but WanFirstLastFrameToVideo pins the
 * clip's final frame too — the in-betweening leg. Two keyframes from the
 * Qwen leg + this = a controlled move set, no new models.
 *
 * length is FRAMES (Wan wants 4k+1: 17, 21, 33...). 640x640 @ length 21 is
 * the sane sprite default: ~5s of motion at 16fps costs nothing to crop.
 */
export function wanI2V({
  image,
  endImage = null,
  prompt,
  negative = WAN_NEGATIVE,
  extraNegative = null,
  width = 640,
  height = 640,
  length = 21,
  seed = 7,
  steps = 20,
  cfg = 3.5,
  shift = 5.0,
  loraHigh = null,
  loraLow = null,
  loraStrength = 0.8,
  /** Decode tile edge. Lower it on a loaded box — see the `dec` note. */
  tileSize = 128,
  /**
   * Frames per temporal decode window. `null` means ONE window for the whole
   * clip, which is the default because anything below `length` puts a
   * cross-fade seam in the animation at every boundary — measured, see `dec`.
   *
   * Pass a number to go back to a windowed decode when the box is too loaded
   * to afford the single-window transient. That is a headroom trade with a
   * known cost in ruined frames, not a neutral setting.
   */
  temporalSize = null,
  temporalOverlap = 4,
  lorasHigh = null,
  lorasLow = null,
  unetHigh = MODELS.wanHigh,
  unetLow = MODELS.wanLow,
} = {}) {
  if (!image) throw new Error("[graphs] wanI2V needs an uploaded image name");
  if (!prompt) throw new Error("[graphs] wanI2V needs a prompt");
  if ((length - 1) % 4 !== 0) throw new Error(`[graphs] wan length must be 4k+1 frames, got ${length}`);
  const half = Math.floor(steps / 2);
  const high = lorasHigh ?? (loraHigh ? [{ name: loraHigh, strength: loraStrength }] : []);
  const low = lorasLow ?? (loraLow ? [{ name: loraLow, strength: loraStrength }] : []);
  // ModelSamplingSD3 sets Wan's sigma shift; every working Wan 2.2 workflow
  // (official template AND the pixel-animate community one) carries it, and
  // omitting it skews the noise schedule toward mush.
  const g = {
    uh: { class_type: "UnetLoaderGGUF", inputs: { unet_name: unetHigh } },
    ul: { class_type: "UnetLoaderGGUF", inputs: { unet_name: unetLow } },
    sh: { class_type: "ModelSamplingSD3", inputs: { model: ["uh", 0], shift } },
    sl: { class_type: "ModelSamplingSD3", inputs: { model: ["ul", 0], shift } },
    c: { class_type: "CLIPLoader", inputs: { clip_name: MODELS.wanClip, type: "wan", device: "default" } },
    v: { class_type: "VAELoader", inputs: { vae_name: MODELS.wanVae } },
    img: { class_type: "LoadImage", inputs: { image } },
    pos: { class_type: "CLIPTextEncode", inputs: { clip: ["c", 0], text: prompt } },
    neg: { class_type: "CLIPTextEncode", inputs: { clip: ["c", 0], text: extraNegative ? `${negative}, ${extraNegative}` : negative } },
    i2v: {
      class_type: endImage ? "WanFirstLastFrameToVideo" : "WanImageToVideo",
      inputs: {
        positive: ["pos", 0], negative: ["neg", 0], vae: ["v", 0],
        width, height, length, batch_size: 1, start_image: ["img", 0],
      },
    },
    kh: {
      class_type: "KSamplerAdvanced",
      inputs: {
        model: ["sh", 0], positive: ["i2v", 0], negative: ["i2v", 1], latent_image: ["i2v", 2],
        add_noise: "enable", noise_seed: seed, steps, cfg, sampler_name: "euler", scheduler: "simple",
        start_at_step: 0, end_at_step: half, return_with_leftover_noise: "enable",
      },
    },
    kl: {
      class_type: "KSamplerAdvanced",
      inputs: {
        model: ["sl", 0], positive: ["i2v", 0], negative: ["i2v", 1], latent_image: ["kh", 0],
        add_noise: "disable", noise_seed: seed, steps, cfg, sampler_name: "euler", scheduler: "simple",
        start_at_step: half, end_at_step: steps, return_with_leftover_noise: "disable",
      },
    },
    // DECODE FENCE + TILED decode. Two measured RAM cliffs live between the
    // last sampler step and the frames (2026-08-05, guard.log):
    //   1. decoding a whole 17-33 frame batch at once — bounded by tiling
    //      (256px tiles, ≤8 frames per temporal chunk; seams are a non-issue
    //      for art headed into the pixel crush);
    //   2. the expert→VAE transition itself — "Requested to load WanVAE"
    //      with an 11.6GB expert still resident cratered the capped VM from
    //      9GiB available to 1.5 in ten seconds. The KJNodes passthrough
    //      unloads every model BEFORE the VAE stage loads; the latent rides
    //      through it, which is what forces the ordering.
    purge: {
      class_type: "VRAM_Debug",
      inputs: { empty_cache: true, gc_collect: true, unload_all_models: true, any_input: ["kl", 0] },
    },
    // tile 128: the fence run still drew ~10GB of system RAM at decode
    // (bottomed 2.5GiB avail) — per-tile staging shrinks with tile area,
    // and 128px quarters it again. Sub-tile seams don't survive the crush.
    //
    // 2026-08-06: 2.5GiB of headroom was not enough margin. Three runs at
    // 21/17/9 frames all died here, and the guard log named the cause —
    // `SOFT (wsl 0.7-1.1GiB available)`, i.e. the guard's own 1.2GiB floor.
    // It reads as a mystery interrupt because a SOFT strike writes no
    // guard-tripped.json (only HARD does), so the absence of that file is
    // NOT evidence the guard stayed out of it. Frame count did not matter,
    // which is the tell that the transient is the decode's staging and not
    // the batch. `tileSize` is now a caller knob so a loaded box can trade
    // seams — already argued irrelevant under the crush — for headroom.
    //
    // ── THE TEMPORAL AXIS IS NOT THE SPATIAL ONE, AND IT LEAVES MARKS ──────
    //
    // 2026-08-07: the dog walk's unusable frames were 4, 5, 8, 12, 13, 16, and
    // 4/8/12/16 are exactly where `temporal_size: 8` / `temporal_overlap: 4`
    // makes its windows meet. The decoder CROSS-FADES those windows, so where
    // a limb moves fast the two decodes disagree and the blend arrives as a
    // double exposure — frame 16 carries two complete leg positions at half
    // strength each, which a motion smear cannot do.
    //
    // MEASURED, one variable, same seed / master / prompt / canvas:
    //
    //     temporal_size  8   worst frame 10.43% ghost, 7 of 21 flagged   435s
    //     temporal_size 24   worst frame  0.23% ghost, 0 of 21 flagged   556s
    //
    // The whole fixed clip is flatter than the CLEANEST frames of the seamed
    // one. `ghost.ts` scores it, `ghost.test.ts` pins the pair, and
    // `docs/PLAN_DOG_WALK.md` §1 has the tables.
    //
    // The argument that spatial seams "don't survive the crush" does NOT carry
    // over. A spatial seam is a hairline inside one frame; a temporal seam is a
    // whole frame the animation cannot use. So the default is ONE window, and
    // the 28% it costs in wall clock buys back a third of the frames.
    //
    // The RAM this spends is the same currency `tileSize` spends. If a loaded
    // box cannot afford it, the cheap way to buy headroom is a smaller canvas
    // — which the texel budget wants anyway — not a windowed decode.
    dec: {
      class_type: "VAEDecodeTiled",
      inputs: {
        samples: ["purge", 0], vae: ["v", 0], tile_size: tileSize, overlap: 32,
        // +4 rather than exactly `length` so the window is unambiguously wider
        // than the clip and no off-by-one reintroduces a single seam at the end.
        temporal_size: temporalSize ?? length + 4, temporal_overlap: temporalOverlap,
      },
    },
    out: { class_type: "SaveImage", inputs: { images: ["dec", 0], filename_prefix: "spriteforge/wan" } },
  };
  if (endImage) {
    g.imgEnd = { class_type: "LoadImage", inputs: { image: endImage } };
    g.i2v.inputs.end_image = ["imgEnd", 0];
  }
  // Chain order matters: unet → lora(s) → sigma shift → sampler. The LoRAs
  // must sit UNDER the shift so ModelSamplingSD3 wraps the patched model.
  g.sh.inputs.model = chainLoras(g, ["uh", 0], high, "lh");
  g.sl.inputs.model = chainLoras(g, ["ul", 0], low, "ll");
  return g;
}

/**
 * WAN 2.2 TI2V-5B — the same clip from one dense model instead of two experts.
 *
 * ── WHY THIS EXISTS: THE BINDING CONSTRAINT IS HOST RAM, NOT VRAM ───────────
 *
 * The A14B path reads 24GB of GGUF (12.0 + 12.0) and Linux page-caches every
 * byte. `free` calls that cache AVAILABLE because it is reclaimable, so nothing
 * inside WSL looks wrong, while Windows counts the balloon as used. Measured on
 * a real clip: host +25.3GB against ComfyUI's own RSS +10.1GB — the gap is page
 * cache. At a 32GB WSL cap the run holds flat through every sampling step and
 * then the VAE decode takes available to 0.7GiB and `guard.mjs` interrupts at
 * its 1.2GiB floor. 1024²/21f and 640²/17f die identically, which is the tell:
 * the cost is both experts RESIDENT plus decode staging, not the batch.
 *
 * This leg reads 5.40 (unet) + 6.74 (umt5) + 1.41 (2.2 VAE) = 13.55GB. That is
 * not a speed optimisation, it is the difference between a run that finishes
 * and one that does not.
 *
 * ── FOUR WAYS THIS GRAPH IS NOT `wanI2V` WITH ONE LOADER ────────────────────
 *
 * 1. ONE model, so ONE sampler. The A14B pair splits the schedule across two
 *    `KSamplerAdvanced` halves because the experts are noise-specialised.
 *    There is no high/low here, so a plain `KSampler` runs the whole schedule.
 * 2. The conditioning does NOT pass through an i2v node. `WanImageToVideo`
 *    returns (positive, negative, latent); `Wan22ImageToVideoLatent` returns a
 *    LATENT ONLY, so the text encodes wire straight into the sampler.
 * 3. The 2.2 VAE is 16× spatial, not 8×. The latent node computes
 *    `height // 16`, so `MODELS.wanVae22` is not interchangeable with the 2.1
 *    VAE — the wrong one decodes to garbage rather than raising.
 * 4. THE PIXEL LoRAs DO NOT APPLY, and this refuses them rather than
 *    attaching them. `styly pixel-animate` is an A14B adapter and `pix3lwalk`
 *    ships a HIGH-NOISE half — both are keyed to a two-expert architecture that
 *    is not here. Silently loading one is either a hard failure deep in the
 *    sampler or, worse, a no-op that looks like the LoRA had no effect. As of
 *    2026-08-08 no 5B-compatible pixel adapter is published; the caller has to
 *    decide to run without one.
 */
export function wanTi2v5B({
  image,
  prompt,
  negative = WAN_NEGATIVE,
  extraNegative = null,
  width = 640,
  height = 640,
  length = 21,
  seed = 7,
  steps = 20,
  cfg = 3.5,
  shift = 5.0,
  loras = null,
  tileSize = 128,
  /** Null ⇒ one window for the whole clip. Same contract as `wanI2V`. */
  temporalSize = null,
  temporalOverlap = 4,
  unet = MODELS.wanSmall,
  vae = MODELS.wanVae22,
} = {}) {
  if (!image) throw new Error("[graphs] wanTi2v5B needs an uploaded image name");
  if (!prompt) throw new Error("[graphs] wanTi2v5B needs a prompt");
  if ((length - 1) % 4 !== 0) throw new Error(`[graphs] wan length must be 4k+1 frames, got ${length}`);
  // The latent node steps width/height by 32 and divides by 16. A size off the
  // grid is silently rounded by the sampler and the frames come back a
  // different shape than the caller asked for, which the slicer then reads as
  // a bad cut — so refuse it here where the number is still a number.
  if (width % 32 !== 0 || height % 32 !== 0) {
    throw new Error(`[graphs] wanTi2v5B needs width/height on a 32px grid, got ${width}x${height}`);
  }
  for (const l of loras ?? []) {
    if (A14B_ONLY_LORAS.some((n) => l.name?.includes(n))) {
      throw new Error(
        `[graphs] "${l.name}" is a Wan 2.2 A14B adapter and cannot load on TI2V-5B — ` +
          "5B is one dense model with no high/low expert split. Run the 5B leg without it, " +
          "or use the A14B leg (which needs ~31GB of reads and currently dies at the VAE decode).",
      );
    }
  }
  const g = {
    u: { class_type: "UnetLoaderGGUF", inputs: { unet_name: unet } },
    s: { class_type: "ModelSamplingSD3", inputs: { model: ["u", 0], shift } },
    c: { class_type: "CLIPLoader", inputs: { clip_name: MODELS.wanClip, type: "wan", device: "default" } },
    v: { class_type: "VAELoader", inputs: { vae_name: vae } },
    img: { class_type: "LoadImage", inputs: { image } },
    pos: { class_type: "CLIPTextEncode", inputs: { clip: ["c", 0], text: prompt } },
    neg: {
      class_type: "CLIPTextEncode",
      inputs: { clip: ["c", 0], text: extraNegative ? `${negative}, ${extraNegative}` : negative },
    },
    lat: {
      class_type: "Wan22ImageToVideoLatent",
      inputs: { vae: ["v", 0], width, height, length, batch_size: 1, start_image: ["img", 0] },
    },
    k: {
      class_type: "KSampler",
      inputs: {
        model: ["s", 0], positive: ["pos", 0], negative: ["neg", 0], latent_image: ["lat", 0],
        seed, steps, cfg, sampler_name: "euler", scheduler: "simple", denoise: 1.0,
      },
    },
    // The same decode fence as the A14B leg, and for the same reason — the
    // expert→VAE transition is where the RAM cliff lives. It is cheaper here
    // (one 5.4GB model to unload rather than two 12GB ones) but the ordering
    // discipline is identical, so it stays.
    purge: {
      class_type: "VRAM_Debug",
      inputs: { empty_cache: true, gc_collect: true, unload_all_models: true, any_input: ["k", 0] },
    },
    dec: {
      class_type: "VAEDecodeTiled",
      inputs: {
        samples: ["purge", 0], vae: ["v", 0], tile_size: tileSize, overlap: 32,
        // ONE TEMPORAL WINDOW — the same default as `wanI2V`, and for the same
        // measured reason. See the long note on that node: `temporal_size: 8`
        // cross-fades its window boundaries and the dog walk's unusable frames
        // (4, 5, 8, 12, 13, 16) were exactly where those windows met. 10.43%
        // worst-frame ghost / 7 of 21 flagged, against 0.23% / 0 at one window.
        //
        // This builder shipped with `8` hardcoded for one day because it was
        // written from the pre-fix version of `wanI2V`. A second copy of a
        // setting is a second copy of its bug, which is why both now read the
        // same expression and `decode-window.test.ts` pins them together.
        //
        // ⚠️ It costs RAM, and this is the leg that can AFFORD it: one 5.4GB
        // model resident instead of two 12GB experts. On A14B the same default
        // is in direct tension with the guard floor the decode already dies at.
        temporal_size: temporalSize ?? length + 4, temporal_overlap: temporalOverlap,
      },
    },
    out: { class_type: "SaveImage", inputs: { images: ["dec", 0], filename_prefix: "spriteforge/wan5b" } },
  };
  g.s.inputs.model = chainLoras(g, ["u", 0], loras ?? [], "l");
  return g;
}

/**
 * THE H3 CANDIDATE LEG — MiniMax H3 fl2va (chapter 14), under measurement.
 *
 * Wired from ComfyUI's own `video_minimax_h3_i2v` template, with three
 * deliberate departures, each of which is a claim this experiment is testing:
 *
 *  1. `UnetLoaderGGUF`, not `UNETLoader`. The official smallest unet is a
 *     20.96GB safetensors; the community pruned Q3_K_M is 8.9GB. Its GGUF
 *     header declares arch `wan`, which is what lets it past city96's
 *     IMG_ARCH_LIST — ComfyUI itself detects H3 from the tensor keys
 *     (`video_patch_proj` + `audio_patch_proj`), not the header, so the
 *     mislabel is load-bearing rather than a mistake.
 *  2. NO audio VAE and no `VAEDecodeAudio`. The latent is a NestedTensor pair
 *     and the audio half is generated regardless — that cost cannot be
 *     removed — but a sprite never decodes it, which saves the file and the
 *     decode. `MiniMaxH3ImageToVideo` takes no `audio_vae`, so nothing else
 *     in the graph needs it.
 *  3. `BasicGuider`, so CFG is effectively 1 and there is no negative prompt.
 *     That is the template's own wiring, not a simplification. It means
 *     WAN_NEGATIVE — including its ban on "character shrinking" — has no
 *     equivalent here, which is worth remembering before comparing scale
 *     swing against a Wan arm that had one.
 *
 * `endImage` is the end pin, and it is the reason this leg is interesting at
 * all beyond memory: H3 takes first AND last frames natively, which is the
 * constraint chapter 15 identifies as the lead on the receding one-shots.
 */
export function minimaxH3I2V({
  image,
  endImage = null,
  prompt,
  width = 576,
  height = 576,
  length = 5,
  seed = 7,
  steps = 20,
  unet = MODELS.h3Unet,
  clip = MODELS.h3Clip,
  vae = MODELS.h3Vae,
  tileSize = 512,
  overlap = 32,
  temporalSize = null,
  temporalOverlap = 8,
  tiled = true,
} = {}) {
  if (!prompt) throw new Error("[graphs] minimaxH3I2V needs a prompt");
  if (length !== h3Length(length)) {
    throw new Error(`[graphs] h3 length must be on the 17k+5 grid, got ${length} (nearest ${h3Length(length)})`);
  }
  if (width % 32 || height % 32) {
    throw new Error(`[graphs] h3 canvas must be a multiple of 32, got ${width}x${height}`);
  }
  const g = {
    u: { class_type: "UnetLoaderGGUF", inputs: { unet_name: unet } },
    c: { class_type: "CLIPLoader", inputs: { clip_name: clip, type: "minimax", device: "default" } },
    v: { class_type: "VAELoader", inputs: { vae_name: vae } },
    i2v: {
      class_type: "MiniMaxH3ImageToVideo",
      inputs: {
        clip: ["c", 0], vae: ["v", 0], prompt,
        width, height, length,
      },
    },
    /**
     * FREE THE 15GB TEXT ENCODER THE MOMENT ITS OUTPUT EXISTS.
     *
     * Chapter 14's whole case for H3 was that a single-model pipeline can
     * "encode, free the encoder, then load unet+VAE" where Wan must hold two
     * experts at once. Measured on 2026-08-09, **ComfyUI does not do that by
     * itself.** The log for the first run reads, in order:
     *
     *     Requested to load MiniMaxH3TEModel_   14960.20 MB
     *     Requested to load MiniMaxH3VideoVAE    4966.19 MB
     *     Requested to load MiniMaxH3            8783.23 MB
     *
     * with no unload between them. That is 28.7GB of weights against 24GB of
     * VRAM, so the encoder does not get freed — it gets OFFLOADED, and
     * ComfyUI's offload device is the CPU. 15GB of a text encoder we will
     * never call again lands in system RAM, which is the one resource this
     * box does not have, and the decode then meets a 1.3GiB floor.
     *
     * So the "free the encoder first" step has to be asked for explicitly.
     * `any_input` is typed `*`, which is what lets a CONDITIONING ride through
     * a node whose real job is the side effect.
     */
    purgeTE: {
      class_type: "VRAM_Debug",
      inputs: { empty_cache: true, gc_collect: true, unload_all_models: true, any_input: ["i2v", 0] },
    },
    guide: { class_type: "BasicGuider", inputs: { model: ["u", 0], conditioning: ["purgeTE", 0] } },
    noise: { class_type: "RandomNoise", inputs: { noise_seed: seed } },
    samp: { class_type: "KSamplerSelect", inputs: { sampler_name: "res_multistep" } },
    sig: { class_type: "BasicScheduler", inputs: { model: ["u", 0], scheduler: "simple", steps, denoise: 1 } },
    k: {
      class_type: "SamplerCustomAdvanced",
      inputs: {
        noise: ["noise", 0], guider: ["guide", 0], sampler: ["samp", 0],
        sigmas: ["sig", 0], latent_image: ["i2v", 1],
      },
    },
    /**
     * DROP THE STACK BEFORE DECODING — the same `purge` node `wanI2V` carries,
     * here for a reason measured on this leg on 2026-08-09.
     *
     * `unload_all_models` frees them outright instead. Nothing downstream of
     * this node needs the unet or the text encoder; the VAE reloads on demand.
     */
    purge: {
      class_type: "VRAM_Debug",
      inputs: { empty_cache: true, gc_collect: true, unload_all_models: true, any_input: ["k", 0] },
    },
    dec: tiled
      ? {
          class_type: "VAEDecodeTiled",
          inputs: {
            samples: ["purge", 0],
            vae: ["v", 0],
            tile_size: tileSize,
            overlap,
            temporal_size: temporalSize ?? length + 4,
            temporal_overlap: temporalOverlap,
          },
        }
      : { class_type: "VAEDecode", inputs: { samples: ["purge", 0], vae: ["v", 0] } },
    out: { class_type: "SaveImage", inputs: { images: ["dec", 0], filename_prefix: "spriteforge/h3" } },
  };
  if (image) {
    g.img = { class_type: "LoadImage", inputs: { image } };
    g.i2v.inputs.first_frame = ["img", 0];
  }
  if (endImage) {
    g.imgEnd = { class_type: "LoadImage", inputs: { image: endImage } };
    g.i2v.inputs.last_frame = ["imgEnd", 0];
  }
  return g;
}
