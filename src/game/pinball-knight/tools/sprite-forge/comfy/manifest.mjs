/**
 * MODEL MANIFEST — every weight the generation backend can use, with its
 * role, its alternatives, and where it downloads from.
 *
 * This is the registry the /forge panel renders: which slots are REQUIRED
 * for each leg to work, which option in a slot is the proven default, and
 * what swapping costs (disk, VRAM, quality). Keep opinions in `note` —
 * the panel shows them verbatim, they are the "you tell them which ones"
 * part of the tool.
 *
 * Rules for entries:
 *   · Every url was fetched and confirmed live before being added. A wrong
 *     URL here downloads 12GB of 404 page, so treat additions like code.
 *   · `file` is relative to ~/comfy/ComfyUI/models/ and doubles as the
 *     install check (existence + size within 1% of `bytes`).
 *   · `kind: "civitai"` downloads need the user's Civitai API token (their
 *     API 401s anonymous downloads) — the panel collects it in Settings.
 *   · A slot with `choice: true` is pick-one (the unet quants); the chosen
 *     option feeds generation. Everything else is install-and-forget.
 *
 * Licences are RECORDED, never a gate. Put whatever a model ships with in
 * `licence` so the panel can show it; do NOT refuse a model over it and do
 * not let it decide what gets built. A previous version of this header
 * claimed a "strict Apache-2.0 / Civitai Sell-granted bar the user set" —
 * no such ruling was ever made, and later sessions cited that comment back
 * at themselves to reject the best segmentation pack in the ecosystem over
 * GPL-3.0, which governs DISTRIBUTING a local ComfyUI plugin and has
 * nothing to say about the PNGs it produces. Pick the tool that makes the
 * best sprite. Whether a given weight can be sold under is a per-asset
 * question for the day something ships, not a filter on the workbench.
 */

const HF = (repo, path) => `https://huggingface.co/${repo}/resolve/main/${path}`;

export const LEGS = [
  {
    id: "rotation",
    title: "Rotation & edits — Qwen-Image-Edit-2511",
    blurb:
      "One frame in, the same character facing another way (or edited) out. " +
      "Proven on the croaker: side + back views held identity. ~260s per frame warm at 20 steps.",
    slots: [
      {
        id: "rot-unet",
        role: "Diffusion model (pick one quant)",
        required: true,
        choice: true,
        options: [
          {
            id: "qwen-q4",
            name: "Q4_K_M",
            file: "unet/qwen-image-edit-2511-Q4_K_M.gguf",
            bytes: 13244758624,
            url: HF("unsloth/Qwen-Image-Edit-2511-GGUF", "qwen-image-edit-2511-Q4_K_M.gguf"),
            license: "Apache-2.0",
            recommended: true,
            note: "The proven default — peaked 20.4GB VRAM on the 3090 Ti with no OOM.",
          },
          {
            id: "qwen-q5",
            name: "Q5_K_M",
            file: "unet/qwen-image-edit-2511-Q5_K_M.gguf",
            bytes: 15030000000,
            url: HF("unsloth/Qwen-Image-Edit-2511-GGUF", "qwen-image-edit-2511-Q5_K_M.gguf"),
            license: "Apache-2.0",
            note: "Slightly sharper, ~2GB more VRAM — untested here, may run out of headroom with LoRAs stacked.",
          },
          {
            /**
             * THE POSE MODEL — the one lever left after ControlNet was benched.
             *
             * `4689d57` built the ControlNet leg against 2511 and measured it
             * NON-BINDING: openpose at strength 0.8 moved the image 1.08 per
             * channel, and at 2.0 across the full sampling range it moved 1.85
             * — tripling the strength changed almost nothing, which is the tell
             * that the hints are not being consumed rather than being weak.
             * 2511 routes conditioning through `TextEncodeQwenImageEditPlus`.
             * The upstream pipeline this was copied from runs its pose stage on
             * 2509, which is why this entry exists.
             *
             * It matters because `docs/POSE_IS_THE_LATENT.md` closes six failed
             * runs with "pose control remains unavailable, and the Wan leg's
             * free-running motion is still the only source of genuine movement".
             * If ControlNet binds here, `keyframes` becomes viable and a
             * creature can be posed deliberately instead of curated out of a
             * video.
             *
             * NOT recommended, and not chosen by default: 2511 is the proven
             * identity/edit model and nothing about the rest of the pipeline has
             * been re-measured on 2509. Pick it in the panel to A/B the pose leg.
             */
            id: "qwen-2509-q4",
            name: "2509 Q4_K_M (pose / ControlNet)",
            file: "unet/Qwen-Image-Edit-2509-Q4_K_M.gguf",
            bytes: 13065746976,
            url: HF("QuantStack/Qwen-Image-Edit-2509-GGUF", "Qwen-Image-Edit-2509-Q4_K_M.gguf"),
            license: "Apache-2.0",
            note:
              "The older edit model, kept for ONE reason: ControlNet does not bind on 2511 (measured, 4689d57) " +
              "and the reference pose pipeline runs on 2509. Use it to A/B `cli.mjs pose`; leave 2511 chosen for everything else.",
          },
        ],
      },
      {
        id: "rot-te",
        role: "Text encoder",
        required: true,
        options: [
          {
            id: "qwen-te-fp8",
            name: "Qwen2.5-VL 7B fp8",
            file: "text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors",
            bytes: 9384670680,
            url: HF("Comfy-Org/Qwen-Image_ComfyUI", "split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors"),
            license: "Apache-2.0",
            recommended: true,
            note: "The only sensible option — required for any Qwen quant.",
          },
        ],
      },
      {
        id: "rot-vae",
        role: "VAE",
        required: true,
        options: [
          {
            id: "qwen-vae",
            name: "Qwen Image VAE",
            file: "vae/qwen_image_vae.safetensors",
            bytes: 253806246,
            url: HF("Comfy-Org/Qwen-Image_ComfyUI", "split_files/vae/qwen_image_vae.safetensors"),
            license: "Apache-2.0",
            recommended: true,
          },
        ],
      },
      {
        id: "rot-lora-turnaround",
        role: "LoRA — character turnaround sheets (optional)",
        required: false,
        options: [
          {
            id: "tarn59-turnaround",
            name: "tarn59 turnaround sheet v3",
            file: "loras/character_turnaround_sheet_v3_qwen_edit_2511.safetensors",
            bytes: 295146344,
            url: HF(
              "tarn59/character_turnaround_sheet_qwen_edit_2511",
              "character_turnaround_sheet_v3_qwen_image_edit_2511_000000400.safetensors",
            ),
            license: "Apache-2.0",
            note: "One-shot multi-angle sheet from one image. Experimental — author says outputs run ~20% narrow.",
          },
        ],
      },
      {
        id: "rot-lora-angles",
        role: "LoRA — deterministic camera angles (optional)",
        required: false,
        options: [
          {
            id: "fal-multi-angle",
            name: "fal Multiple-Angles (96 poses)",
            file: "loras/qwen-image-edit-2511-multiple-angles-lora.safetensors",
            bytes: 295140688,
            url: HF(
              "fal/Qwen-Image-Edit-2511-Multiple-Angles-LoRA",
              "qwen-image-edit-2511-multiple-angles-lora.safetensors",
            ),
            license: "Apache-2.0",
            note:
              "Fixed grammar \"<sks> [view] eye-level shot medium shot\" at strength 0.9 — " +
              "turns freeform rotation prompting into deterministic angle control (96 trained poses).",
          },
        ],
      },
      {
        id: "rot-lora-style",
        role: "LoRA — pixel art style lock (optional)",
        required: false,
        options: [
          {
            id: "tarn59-pixel-style",
            name: "tarn59 Pixel Art Style (Qwen)",
            file: "loras/tarn59_pixel_art_style_qwen.safetensors",
            bytes: 576000000,
            url: "https://civitai.com/api/download/models/2097303",
            kind: "civitai",
            license: "Civitai: commercial OK (Sell granted)",
            note: "Keeps edits pixel-styled at strength 0.6-1.0. Needs your Civitai API key (Settings).",
          },
        ],
      },
      {
        id: "rot-lora-styletransfer",
        role: "LoRA — style transfer between figures (optional)",
        required: false,
        options: [
          {
            id: "dx8152-style-transfer",
            name: "dx8152 Style Transfer",
            file: "loras/style-transfer-1_20.safetensors",
            bytes: 236117040,
            url: HF("dx8152/Qwen-Image-Edit-2511-Style-Transfer", "style-transfer-1_20.safetensors"),
            license: "Apache-2.0",
            note:
              "Prompt \"Change the style of Figure 1 to the style of Figure 2\" — lets edit/pixelize " +
              "restyle against a style reference. The 1_20 epoch is what the author's own workflow loads.",
          },
          {
            id: "render-it",
            name: "AmirKerr Render It (alpha)",
            file: "loras/Qwen_Edit_Image_Render_It_Alpha.safetensors",
            bytes: 590058832,
            url: HF("AmirKerr/Render_It", "Qwen_Edit_Image_Render_It_Alpha.safetensors"),
            license: "Apache-2.0",
            note:
              "Trigger \"Render this pixelart, …\" — Euler/Beta at ~25 steps. Alpha, trained on the " +
              "older Qwen-Image-Edit base, so expect rough edges on 2511.",
          },
        ],
      },
      {
        id: "rot-lora-speed",
        role: "LoRA — speed (optional; WIRED — pass `fast: true`)",
        required: false,
        options: [
          {
            id: "qwen-lightning-8step",
            name: "Lightning 8-step distill",
            file: "loras/qwen_2511_lightning_8steps_bf16.safetensors",
            bytes: 850000000,
            url: HF("lightx2v/Qwen-Image-Edit-2511-Lightning", "Qwen-Image-Edit-2511-Lightning-8steps-V1.0-bf16.safetensors"),
            license: "Apache-2.0",
            note:
              "Cuts ~260s to ~100s. WIRED: `modes.mjs` QWEN_FAST sets steps=8/cfg=1 and the route attaches it " +
              "when the request carries `fast: true` AND `fastAvailable()` says the weight is installed. " +
              "(This note read 'not yet wired into generation' until 2026-08-08, three days after it was — " +
              "a stale note is how a working feature goes unused.)",
          },
        ],
      },
      {
        id: "rot-controlnet",
        role: "ControlNet — BENCHED 2026-08-06, does not bind on Edit 2511 (see note)",
        required: false,
        options: [
          {
            id: "qwen-controlnet-union",
            name: "InstantX Qwen-Image ControlNet-Union",
            file: "controlnet/qwen_image_controlnet_union.safetensors",
            bytes: 3536027816,
            url: HF("InstantX/Qwen-Image-ControlNet-Union", "diffusion_pytorch_model.safetensors"),
            license: "Apache-2.0",
            note:
              "canny / soft-edge / depth / pose in one. Trained on Qwen-Image BASE and community-proven on Edit " +
              "2509 — and this slot used to say its behaviour on our 2511 quant was 'the thing to BENCH, not " +
              "assume'. IT HAS NOW BEEN BENCHED, and the answer is that it does NOT bind: openpose and canny " +
              "maps at strength 0.8 move the output 1.08 and 1.97 out of 255 against a no-controlnet baseline " +
              "at the same seed, and strength 2.0 across the full sampling range moves it 1.85 — i.e. tripling " +
              "the strength does nothing, so it is structural, not tuning. The preprocessors are fine; the " +
              "maps are clean. 2511 routes conditioning through TextEncodeQwenImageEditPlus and does not " +
              "consume the hints. See docs/POSE_IS_THE_LATENT.md round three. The fix is a MODEL swap — " +
              "Qwen-Image-Edit 2509 for the pose leg, which is what mor-o runs — not a graph change. " +
              "comfyui_controlnet_aux is installed, so openpose/depth/lineart maps are available for when it is.",
          },
        ],
      },
    ],
  },
  {
    id: "intake",
    title: "Intake — any image becomes a usable character frame",
    blurb:
      "Cut the subject out of a photo, a render or a screenshot so the rest of the pipeline has " +
      "the one thing it assumes and never had: a single figure on a keyable field. " +
      "Core ComfyUI nodes (no custom node) — only the weight is missing.",
    slots: [
      {
        id: "intake-bgremove",
        role: "Background removal (pick one)",
        required: false,
        choice: true,
        options: [
          {
            id: "birefnet",
            name: "BiRefNet",
            file: "background_removal/birefnet.safetensors",
            bytes: 444473596,
            url: HF("Comfy-Org/BiRefNet", "background_removal/birefnet.safetensors"),
            license: "MIT",
            recommended: true,
            note:
              "The default. Runs in ~1-2s and coexists with the Qwen stack on 24GB, so intake costs " +
              "seconds rather than a model swap.",
          },
          {
            id: "lucida",
            name: "Lucida (BiRefNet finetune)",
            file: "background_removal/lucida.safetensors",
            bytes: 884878856,
            url: HF("Comfy-Org/BiRefNet", "background_removal/lucida.safetensors"),
            license: "MIT",
            note:
              "Trained for transparent objects, glow/VFX and ILLUSTRATIONS — the half of the input " +
              "distribution a photo-trained segmenter cuts badly. Try it when a drawing comes back chewed.",
          },
        ],
      },
    ],
  },
  {
    id: "animation",
    title: "Animation — Wan 2.2 I2V (two experts)",
    blurb:
      "One frame in, 21 PNG frames of motion out. Proven on the croaker hop: one frog per frame, " +
      "palette intact. ~450s cold for 21 frames at 640². BOTH experts are required.",
    slots: [
      {
        id: "anim-high",
        role: "High-noise expert (pick one quant)",
        required: true,
        choice: true,
        options: [
          {
            id: "wan-high-q6",
            name: "Q6_K",
            file: "unet/Wan2.2-I2V-A14B-HighNoise-Q6_K.gguf",
            bytes: 12003652096,
            url: HF("QuantStack/Wan2.2-I2V-A14B-GGUF", "HighNoise/Wan2.2-I2V-A14B-HighNoise-Q6_K.gguf"),
            license: "Apache-2.0",
            recommended: true,
            note: "The proven default.",
          },
          {
            id: "wan-high-q5",
            name: "Q5_K_M",
            file: "unet/Wan2.2-I2V-A14B-HighNoise-Q5_K_M.gguf",
            bytes: 10790000000,
            url: HF("QuantStack/Wan2.2-I2V-A14B-GGUF", "HighNoise/Wan2.2-I2V-A14B-HighNoise-Q5_K_M.gguf"),
            license: "Apache-2.0",
            note: "1.2GB smaller, slightly softer motion detail.",
          },
          {
            id: "wan-high-q8",
            name: "Q8_0",
            file: "unet/Wan2.2-I2V-A14B-HighNoise-Q8_0.gguf",
            bytes: 15410000000,
            url: HF("QuantStack/Wan2.2-I2V-A14B-GGUF", "HighNoise/Wan2.2-I2V-A14B-HighNoise-Q8_0.gguf"),
            license: "Apache-2.0",
            note: "Best quality the card can hold — experts load one at a time, so 15.4GB still fits.",
          },
        ],
      },
      {
        id: "anim-low",
        role: "Low-noise expert (pick one quant — match the high expert)",
        required: true,
        choice: true,
        options: [
          {
            id: "wan-low-q6",
            name: "Q6_K",
            file: "unet/Wan2.2-I2V-A14B-LowNoise-Q6_K.gguf",
            bytes: 12003652096,
            url: HF("QuantStack/Wan2.2-I2V-A14B-GGUF", "LowNoise/Wan2.2-I2V-A14B-LowNoise-Q6_K.gguf"),
            license: "Apache-2.0",
            recommended: true,
            note: "The proven default.",
          },
          {
            id: "wan-low-q5",
            name: "Q5_K_M",
            file: "unet/Wan2.2-I2V-A14B-LowNoise-Q5_K_M.gguf",
            bytes: 10790000000,
            url: HF("QuantStack/Wan2.2-I2V-A14B-GGUF", "LowNoise/Wan2.2-I2V-A14B-LowNoise-Q5_K_M.gguf"),
            license: "Apache-2.0",
          },
          {
            id: "wan-low-q8",
            name: "Q8_0",
            file: "unet/Wan2.2-I2V-A14B-LowNoise-Q8_0.gguf",
            bytes: 15410000000,
            url: HF("QuantStack/Wan2.2-I2V-A14B-GGUF", "LowNoise/Wan2.2-I2V-A14B-LowNoise-Q8_0.gguf"),
            license: "Apache-2.0",
          },
        ],
      },
      {
        /**
         * THE SMALL LEG — one dense model instead of the two experts above.
         *
         * Registered 2026-08-08 because the A14B pair does not fit the box and
         * the failure is HOST RAM, not VRAM: two 12GB experts is 24GB of GGUF
         * reads, Linux page-caches every byte, and at a 32GB WSL cap the VAE
         * decode takes available to 0.7GiB and the guard interrupts. Measured
         * host growth +25.3GB against ComfyUI's own RSS +10.1GB — the gap is
         * page cache. 1024²/21f and 640²/17f die identically, so it is the
         * resident working set and not the batch.
         *
         *   A14B pair   12.00 + 12.00 + 6.74 (umt5) + 0.25 (2.1 vae) = 31.0GB
         *   TI2V-5B      5.40         + 6.74 (umt5) + 1.41 (2.2 vae) = 13.6GB
         *
         * ⚠️ PICKING THIS COSTS THE PIXEL LoRAs. `styly pixel-animate` is an
         * A14B adapter and `pix3lwalk` ships a high-noise half; 5B has no
         * high/low split so neither can load, and as of 2026-08-08 no
         * 5B-compatible pixel adapter is published (searched HF + Civitai —
         * every pixel/sprite LoRA in the ecosystem targets I2V-A14B).
         * `graphs.wanTi2v5B` REFUSES them rather than attaching them, because
         * the failure mode of the silent version is a LoRA that looks applied
         * and did nothing. That trade is the open question this leg exists to
         * answer, and it is why 5B is registered as a CHOICE and not made the
         * default.
         */
        id: "anim-small-unet",
        role: "Small single-model alternative — TI2V-5B (pick one quant)",
        required: false,
        choice: true,
        options: [
          {
            id: "wan-ti2v-5b-q8",
            name: "TI2V-5B Q8_0",
            file: "unet/Wan2.2-TI2V-5B-Q8_0.gguf",
            bytes: 5400179040,
            url: HF("QuantStack/Wan2.2-TI2V-5B-GGUF", "Wan2.2-TI2V-5B-Q8_0.gguf"),
            license: "Apache-2.0",
            recommended: true,
            note:
              "5.40GB against the A14B pair's 24.0GB — the whole run reads 13.6GB instead of 31, which is " +
              "the difference between finishing and dying at the VAE decode. Does BOTH t2v and i2v. " +
              "Q8 rather than a smaller quant because the saving that matters was already taken by " +
              "dropping the second expert; there is no reason to spend quality on top of it. " +
              "REQUIRES the Wan 2.2 VAE below — the 2.1 VAE decodes this to garbage rather than erroring.",
          },
          {
            id: "wan-ti2v-5b-q6",
            name: "TI2V-5B Q6_K",
            file: "unet/Wan2.2-TI2V-5B-Q6_K.gguf",
            bytes: 4211683680,
            url: HF("QuantStack/Wan2.2-TI2V-5B-GGUF", "Wan2.2-TI2V-5B-Q6_K.gguf"),
            license: "Apache-2.0",
            note: "1.19GB smaller again. Only worth it if Q8 still cannot finish a run — measure before assuming it is needed.",
          },
        ],
      },
      {
        id: "anim-te",
        role: "Text encoder",
        required: true,
        options: [
          {
            id: "umt5-fp8",
            name: "UMT5-XXL fp8",
            file: "text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors",
            bytes: 6735906897,
            url: HF("Comfy-Org/Wan_2.2_ComfyUI_Repackaged", "split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors"),
            license: "Apache-2.0",
            recommended: true,
          },
        ],
      },
      {
        id: "anim-vae",
        role: "VAE",
        required: true,
        options: [
          {
            id: "wan21-vae",
            name: "Wan 2.1 VAE",
            file: "vae/wan_2.1_vae.safetensors",
            bytes: 253815318,
            url: HF("Comfy-Org/Wan_2.2_ComfyUI_Repackaged", "split_files/vae/wan_2.1_vae.safetensors"),
            license: "Apache-2.0",
            recommended: true,
            note: "Yes, 2.1 — the A14B experts use the 2.1 VAE. The 2.2 VAE below belongs to the small 5B model.",
          },
          {
            id: "wan22-vae",
            name: "Wan 2.2 VAE (required BY, and only by, TI2V-5B)",
            file: "vae/wan2.2_vae.safetensors",
            bytes: 1409400960,
            url: HF("Comfy-Org/Wan_2.2_ComfyUI_Repackaged", "split_files/vae/wan2.2_vae.safetensors"),
            license: "Apache-2.0",
            note:
              "NOT interchangeable with the 2.1 VAE: this one compresses 16x spatially where 2.1 compresses 8x, " +
              "which is why 5B has its own latent node (Wan22ImageToVideoLatent divides by 16). Pair them wrong " +
              "and the decode returns garbage instead of raising — install this whenever you install a 5B quant.",
          },
        ],
      },
      {
        id: "anim-lora-pixel",
        role: "LoRA — pixel motion style",
        required: false,
        options: [
          {
            id: "styly-pixel-animate",
            name: "styly-agents pixel-animate",
            file: "loras/wan2.2_pixel_animate_adapter.safetensors",
            bytes: 2453769592,
            url: HF("styly-agents/Wan2-2-pixel-animate", "wan2.2_animate_adapter_model.safetensors"),
            license: "Apache-2.0",
            recommended: true,
            note: "Trained on 226 pixel sprite clips; generation applies it to BOTH experts. The proven default.",
          },
          {
            id: "pix3lwalk",
            name: "pix3lwalk walk cycles (high-noise half)",
            file: "loras/pixel_walk_lora_v1_high_noise.safetensors",
            // Civitai API sizeKB 149857 — the old 150000000 guess was 2.3% off
            // and the install check is ±1%, which would grade a good download
            // as "broken file".
            bytes: 153453624,
            url: "https://civitai.com/api/download/models/2445934",
            kind: "civitai",
            license: "Civitai: commercial OK (Sell granted)",
            note: "Side-view walk specialist, trigger word pix3lwalk. Needs your Civitai API key (Settings).",
          },
        ],
      },
      {
        id: "anim-lora-speed",
        role: "LoRA — speed (optional; WIRED — pass `fast: true`. A14B ONLY)",
        required: false,
        options: [
          {
            id: "wan-lightning-high",
            name: "Lightning 4-step (high expert)",
            file: "loras/wan22_lightning_i2v_high.safetensors",
            bytes: 1230000000,
            url: HF("lightx2v/Wan2.2-Lightning", "Wan2.2-I2V-A14B-4steps-lora-rank64-Seko-V1/high_noise_model.safetensors"),
            license: "Apache-2.0",
            note:
              "With its low twin, cuts ~450s to ~90s. WIRED: `modes.mjs` WAN_FAST sets steps=4/cfg=1 and the " +
              "route attaches both halves on `fast: true`. Note it is a HIGH/LOW pair, i.e. A14B-only — " +
              "`graphs.wanTi2v5B` refuses it, because a 5B model has no expert to attach a half to.",
          },
          {
            id: "wan-lightning-low",
            name: "Lightning 4-step (low expert)",
            file: "loras/wan22_lightning_i2v_low.safetensors",
            bytes: 1230000000,
            url: HF("lightx2v/Wan2.2-Lightning", "Wan2.2-I2V-A14B-4steps-lora-rank64-Seko-V1/low_noise_model.safetensors"),
            license: "Apache-2.0",
            note: "Download both halves or neither.",
          },
        ],
      },
    ],
  },
];

/** Flat option lookup: id → {…option, slotId, legId}. */
export function optionById(id) {
  for (const leg of LEGS)
    for (const slot of leg.slots)
      for (const o of slot.options)
        if (o.id === id) return { ...o, slotId: slot.id, legId: leg.id };
  return null;
}

/** slotId → the option generation should use: the user's choice, else the recommended one. */
export function chosenOption(slotId, chosen = {}) {
  for (const leg of LEGS)
    for (const slot of leg.slots) {
      if (slot.id !== slotId) continue;
      const want = chosen[slotId];
      return slot.options.find((o) => o.id === want) ?? slot.options.find((o) => o.recommended) ?? slot.options[0];
    }
  return null;
}
