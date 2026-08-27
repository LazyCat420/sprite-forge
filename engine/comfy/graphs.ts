/**
 * DGX Spark ComfyUI API Graph Builders for Sprite Forge.
 * Matched to the unified consistency suite on DGX Spark (GB10 Grace-Blackwell 128GB unified memory):
 * - Krea 2 Turbo / Base + Krea2StyleReferenceHelper (Stage 1: Concept Intake)
 * - SV3D / Zero123++ Multi-View Batch with MultiViewBatchSelector & MultiViewSheetBuilder (Stage 2: 3D Turnaround)
 * - MiniMax H3 Multi-Reference <Picture 1..3> Omni-DiT with MiniMaxH3PromptFormatter & MiniMaxH3MultiRefPacker (Stage 3: Video Movesets)
 */

export interface ConceptGraphOpts {
  prompt: string;
  negativePrompt?: string;
  seed?: number;
  width?: number;
  height?: number;
  steps?: number;
  cfg?: number;
  styleName?: "darkbrush" | "retro_anime" | "pixel_art" | "soft_watercolor";
}

export function buildConceptGraph({
  prompt,
  negativePrompt = "blurry, photorealistic, noise, dark background, cast shadow, extra limbs, deformed",
  seed = Math.floor(Math.random() * 1e9),
  width = 512,
  height = 768,
  steps = 8,
  cfg = 2.0,
  styleName,
}: ConceptGraphOpts): Record<string, any> {
  const nodes: Record<string, any> = {
    "1": {
      class_type: "UNETLoader",
      inputs: {
        unet_name: "krea2_turbo_fp8_scaled.safetensors",
        weight_dtype: "default",
      },
    },
    "2": {
      class_type: "CLIPLoader",
      inputs: {
        clip_name: "qwen3vl_4b_fp8_scaled.safetensors",
        type: "krea2",
      },
    },
    "3": {
      class_type: "VAELoader",
      inputs: {
        vae_name: "qwen_image_vae.safetensors",
      },
    },
    "4": {
      class_type: "CLIPTextEncode",
      inputs: {
        clip: ["2", 0],
        text: prompt + ", pixel art style, solid flat green chroma background, clean silhouette, centered full body sprite",
      },
    },
    "5": {
      class_type: "CLIPTextEncode",
      inputs: {
        clip: ["2", 0],
        text: negativePrompt,
      },
    },
    "6": {
      class_type: "EmptyLatentImage",
      inputs: {
        batch_size: 1,
        height,
        width,
      },
    },
    "7": {
      class_type: "KSampler",
      inputs: {
        cfg,
        denoise: 1.0,
        latent_image: ["6", 0],
        model: ["1", 0],
        negative: ["5", 0],
        positive: ["4", 0],
        sampler_name: "euler",
        scheduler: "normal",
        seed,
        steps,
      },
    },
    "8": {
      class_type: "VAEDecode",
      inputs: {
        samples: ["7", 0],
        vae: ["3", 0],
      },
    },
    "9": {
      class_type: "SaveImage",
      inputs: {
        filename_prefix: "spriteforge/concept",
        images: ["8", 0],
      },
    },
  };

  if (styleName) {
    nodes["style_helper"] = {
      class_type: "Krea2StyleReferenceHelper",
      inputs: {
        style_name: styleName,
        lora_weight: 0.8,
      },
    };
  }

  return nodes;
}

export interface MultiViewTurnaroundGraphOpts {
  image: string;
  engine?: "sv3d" | "zero123";
  character?: string;
  seed?: number;
  cameraOffset?: number;
}

/**
 * SV3D / Zero123++ Multi-View Turnaround Graph with MultiViewBatchSelector & MultiViewSheetBuilder.
 * Extracts South (0°), East (90°), North (180°), and West (270°) in a single atomic pass,
 * and generates both isolated canonical images and a unified contact sheet.
 */
export function buildMultiViewTurnaroundGraph({
  image,
  engine = "sv3d",
  character = "character",
  seed = Math.floor(Math.random() * 1e9),
  cameraOffset = 0,
}: MultiViewTurnaroundGraphOpts): Record<string, any> {
  if (engine === "zero123") {
    return {
      "1": {
        class_type: "LoadImage",
        inputs: { image },
      },
      "2": {
        class_type: "ImageScale",
        inputs: {
          image: ["1", 0],
          upscale_method: "nearest-exact",
          width: 512,
          height: 512,
          crop: "disabled",
        },
      },
      "3": {
        class_type: "UNETLoader",
        inputs: {
          unet_name: "zero123plus_fp16.safetensors",
          weight_dtype: "default",
        },
      },
      "4": {
        class_type: "CLIPLoader",
        inputs: {
          clip_name: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
          type: "minimax",
        },
      },
      "5": {
        class_type: "VAELoader",
        inputs: {
          vae_name: "minimax_h3_video_vae_fp16.safetensors",
        },
      },
      "6": {
        class_type: "VAEEncode",
        inputs: {
          pixels: ["2", 0],
          vae: ["5", 0],
        },
      },
      "7": {
        class_type: "CLIPTextEncode",
        inputs: {
          clip: ["4", 0],
          text: `pixel art multi-view turnaround sheet of ${character}, front view, side profile, and back view, clean sprite alignment, solid flat green chroma background`,
        },
      },
      "8": {
        class_type: "CLIPTextEncode",
        inputs: {
          clip: ["4", 0],
          text: "blurry, noise, photorealistic, cast shadow, dark background",
        },
      },
      "9": {
        class_type: "EmptyLatentImage",
        inputs: {
          batch_size: 6,
          height: 512,
          width: 512,
        },
      },
      "10": {
        class_type: "KSampler",
        inputs: {
          cfg: 2.5,
          denoise: 1.0,
          latent_image: ["9", 0],
          model: ["3", 0],
          negative: ["8", 0],
          positive: ["7", 0],
          sampler_name: "euler",
          scheduler: "normal",
          seed,
          steps: 8,
        },
      },
      "11": {
        class_type: "VAEDecode",
        inputs: {
          samples: ["10", 0],
          vae: ["5", 0],
        },
      },
      "selector": {
        class_type: "MultiViewBatchSelector",
        inputs: {
          images: ["11", 0],
          front_index: 0,
          east_index: 1,
          north_index: 3,
          west_index: 4,
          azimuth_offset: cameraOffset,
        },
      },
      "sheet_builder": {
        class_type: "MultiViewSheetBuilder",
        inputs: {
          image_front: ["selector", 0],
          image_east: ["selector", 1],
          image_north: ["selector", 2],
          image_west: ["selector", 3],
          layout: "horizontal_strip",
        },
      },
      "save_front": {
        class_type: "SaveImage",
        inputs: {
          filename_prefix: "spriteforge/multiview_front",
          images: ["selector", 0],
        },
      },
      "save_east": {
        class_type: "SaveImage",
        inputs: {
          filename_prefix: "spriteforge/multiview_east",
          images: ["selector", 1],
        },
      },
      "save_north": {
        class_type: "SaveImage",
        inputs: {
          filename_prefix: "spriteforge/multiview_north",
          images: ["selector", 2],
        },
      },
      "save_sheet": {
        class_type: "SaveImage",
        inputs: {
          filename_prefix: "spriteforge/multiview_sheet",
          images: ["sheet_builder", 0],
        },
      },
    };
  }

  // SV3D 360-degree orbit turnaround (21 frames)
  return {
    "1": {
      class_type: "LoadImage",
      inputs: { image },
    },
    "2": {
      class_type: "ImageScale",
      inputs: {
        image: ["1", 0],
        upscale_method: "nearest-exact",
        width: 512,
        height: 512,
        crop: "disabled",
      },
    },
    "3": {
      class_type: "CheckpointLoaderSimple",
      inputs: {
        ckpt_name: "sv3d_u.safetensors",
      },
    },
    "4": {
      class_type: "CLIPLoader",
      inputs: {
        clip_name: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
        type: "minimax",
      },
    },
    "5": {
      class_type: "VAELoader",
      inputs: {
        vae_name: "minimax_h3_video_vae_fp16.safetensors",
      },
    },
    "6": {
      class_type: "VAEEncode",
      inputs: {
        pixels: ["2", 0],
        vae: ["5", 0],
      },
    },
    "7": {
      class_type: "CLIPTextEncode",
      inputs: {
        clip: ["4", 0],
        text: `pixel art sprite 360 degree turntable rotation of ${character}, front view, side profile facing right, and back view, clean sprite alignment, solid flat green chroma background`,
      },
    },
    "8": {
      class_type: "CLIPTextEncode",
      inputs: {
        clip: ["4", 0],
        text: "blurry, noise, photorealistic, cast shadow, dark background",
      },
    },
    "9": {
      class_type: "EmptyLatentImage",
      inputs: {
        batch_size: 21,
        height: 512,
        width: 512,
      },
    },
    "10": {
      class_type: "KSampler",
      inputs: {
        cfg: 2.0,
        denoise: 1.0,
        latent_image: ["9", 0],
        model: ["3", 0],
        negative: ["8", 0],
        positive: ["7", 0],
        sampler_name: "euler",
        scheduler: "normal",
        seed,
        steps: 8,
      },
    },
    "11": {
      class_type: "VAEDecode",
      inputs: {
        samples: ["10", 0],
        vae: ["5", 0],
      },
    },
    "selector": {
      class_type: "MultiViewBatchSelector",
      inputs: {
        images: ["11", 0],
        front_index: 0,
        east_index: 5,
        north_index: 10,
        west_index: 15,
        azimuth_offset: cameraOffset,
      },
    },
    "sheet_builder": {
      class_type: "MultiViewSheetBuilder",
      inputs: {
        image_front: ["selector", 0],
        image_east: ["selector", 1],
        image_north: ["selector", 2],
        image_west: ["selector", 3],
        layout: "horizontal_strip",
      },
    },
    "save_front": {
      class_type: "SaveImage",
      inputs: {
        filename_prefix: "spriteforge/multiview_front",
        images: ["selector", 0],
      },
    },
    "save_east": {
      class_type: "SaveImage",
      inputs: {
        filename_prefix: "spriteforge/multiview_east",
        images: ["selector", 1],
      },
    },
    "save_north": {
      class_type: "SaveImage",
      inputs: {
        filename_prefix: "spriteforge/multiview_north",
        images: ["selector", 2],
      },
    },
    "save_sheet": {
      class_type: "SaveImage",
      inputs: {
        filename_prefix: "spriteforge/multiview_sheet",
        images: ["sheet_builder", 0],
      },
    },
  };
}

export interface TurnaroundGraphOpts {
  image?: string;
  facing: "S" | "E" | "N";
  character: string;
  seed?: number;
  denoise?: number;
}

export function buildTurnaroundGraph({
  image,
  facing,
  character,
  seed = Math.floor(Math.random() * 1e9),
}: TurnaroundGraphOpts): Record<string, any> {
  const isEast = facing === "E";
  const isNorth = facing === "N";

  const positivePrompt = isEast
    ? `pixel art sprite of the same ${character}, turned 90 degrees to side profile facing right, exact same armor colors and helmet, flat green chroma background, full body centered`
    : isNorth
      ? `pixel art sprite of the same ${character}, seen from behind, 180 degrees back facing away from camera, rear view of armor and helmet, flat green chroma background, full body centered`
      : `pixel art sprite of the same ${character}, front view facing camera, solid flat green chroma background, full body centered`;

  const negativePrompt = isEast
    ? "front view, facing camera, back view, blurry, photorealistic, noise, dark background, cast shadow, deformed"
    : isNorth
      ? "face, eyes, visor, front view, facing camera, blurry, photorealistic, noise, dark background, cast shadow"
      : "blurry, photorealistic, noise, dark background, cast shadow";

  if (image) {
    return {
      "1": {
        class_type: "LoadImage",
        inputs: { image },
      },
      "2": {
        class_type: "UNETLoader",
        inputs: {
          unet_name: "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
          weight_dtype: "default",
        },
      },
      "3": {
        class_type: "CLIPLoader",
        inputs: {
          clip_name: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
          type: "minimax",
        },
      },
      "4": {
        class_type: "VAELoader",
        inputs: {
          vae_name: "minimax_h3_video_vae_fp16.safetensors",
        },
      },
      "5": {
        class_type: "VAEEncode",
        inputs: {
          pixels: ["1", 0],
          vae: ["4", 0],
        },
      },
      "6": {
        class_type: "CLIPTextEncode",
        inputs: {
          clip: ["3", 0],
          text: positivePrompt,
        },
      },
      "7": {
        class_type: "CLIPTextEncode",
        inputs: {
          clip: ["3", 0],
          text: negativePrompt,
        },
      },
      "8": {
        class_type: "ReferenceLatent",
        inputs: {
          conditioning: ["6", 0],
          latent: ["5", 0],
        },
      },
      "9": {
        class_type: "EmptyLatentImage",
        inputs: {
          batch_size: 1,
          height: 768,
          width: 512,
        },
      },
      "10": {
        class_type: "KSampler",
        inputs: {
          cfg: 2.0,
          denoise: 1.0,
          latent_image: ["9", 0],
          model: ["2", 0],
          negative: ["7", 0],
          positive: ["8", 0],
          sampler_name: "euler",
          scheduler: "normal",
          seed,
          steps: 8,
        },
      },
      "11": {
        class_type: "VAEDecode",
        inputs: {
          samples: ["10", 0],
          vae: ["4", 0],
        },
      },
      "12": {
        class_type: "SaveImage",
        inputs: {
          filename_prefix: `spriteforge/minimax_turnaround_${facing}`,
          images: ["11", 0],
        },
      },
    };
  }

  return {
    "1": {
      class_type: "UNETLoader",
      inputs: {
        unet_name: "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
        weight_dtype: "default",
      },
    },
    "2": {
      class_type: "CLIPLoader",
      inputs: {
        clip_name: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
        type: "minimax",
      },
    },
    "3": {
      class_type: "VAELoader",
      inputs: {
        vae_name: "minimax_h3_video_vae_fp16.safetensors",
      },
    },
    "4": {
      class_type: "CLIPTextEncode",
      inputs: {
        clip: ["2", 0],
        text: positivePrompt,
      },
    },
    "5": {
      class_type: "CLIPTextEncode",
      inputs: {
        clip: ["2", 0],
        text: negativePrompt,
      },
    },
    "6": {
      class_type: "EmptyLatentImage",
      inputs: {
        batch_size: 1,
        height: 768,
        width: 512,
      },
    },
    "7": {
      class_type: "KSampler",
      inputs: {
        cfg: 2.0,
        denoise: 1.0,
        latent_image: ["6", 0],
        model: ["1", 0],
        negative: ["5", 0],
        positive: ["4", 0],
        sampler_name: "euler",
        scheduler: "normal",
        seed,
        steps: 8,
      },
    },
    "8": {
      class_type: "VAEDecode",
      inputs: {
        samples: ["7", 0],
        vae: ["3", 0],
      },
    },
    "9": {
      class_type: "SaveImage",
      inputs: {
        filename_prefix: `spriteforge/minimax_turnaround_${facing}`,
        images: ["8", 0],
      },
    },
  };
}

export interface MultiRefMovesetGraphOpts {
  character: string;
  action: string;
  facing: "S" | "E" | "N";
  frontImage?: string;
  sideImage?: string;
  backImage?: string;
  seed?: number;
  steps?: number;
}

/**
 * MiniMax H3 Multi-Reference Video Moveset Graph with <Picture 1..3> injection,
 * MiniMaxH3PromptFormatter, and MiniMaxH3MultiRefPacker.
 */
export function buildMultiRefMovesetGraph({
  character,
  action,
  facing,
  frontImage,
  sideImage,
  backImage,
  seed = Math.floor(Math.random() * 1e9),
  steps = 8,
}: MultiRefMovesetGraphOpts): Record<string, any> {
  const facingText = facing === "E" ? "side view facing right" : facing === "N" ? "back view" : "front view";

  // Build ref list to determine <Picture 1..N> references
  const refImages = [
    { key: "front", img: frontImage, tag: "<Picture 1>" },
    { key: "side", img: sideImage, tag: "<Picture 2>" },
    { key: "back", img: backImage, tag: "<Picture 3>" },
  ].filter((r) => Boolean(r.img));

  const pictureTags = refImages.map((r) => r.tag).join(" ");
  const basePrompt = pictureTags.length > 0
    ? `pixel art animation clip of ${pictureTags} ${character} performing ${action}, ${facingText}, solid flat green chroma background, locked camera, seamless sprite motion`
    : `pixel art animation clip of fantasy ${character} performing ${action}, ${facingText}, solid flat green chroma background, locked camera, seamless sprite motion`;

  const nodes: Record<string, any> = {
    "1": {
      class_type: "UNETLoader",
      inputs: {
        unet_name: "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
        weight_dtype: "default",
      },
    },
    "2": {
      class_type: "CLIPLoader",
      inputs: {
        clip_name: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
        type: "minimax",
      },
    },
    "3": {
      class_type: "VAELoader",
      inputs: {
        vae_name: "minimax_h3_video_vae_fp16.safetensors",
      },
    },
    "prompt_formatter": {
      class_type: "MiniMaxH3PromptFormatter",
      inputs: {
        prompt: basePrompt,
        character,
        action,
        num_references: Math.max(1, refImages.length),
        facing_tag: facing === "E" ? "side" : facing === "N" ? "back" : "front",
      },
    },
    "4": {
      class_type: "CLIPTextEncode",
      inputs: {
        clip: ["2", 0],
        text: basePrompt,
      },
    },
    "5": {
      class_type: "CLIPTextEncode",
      inputs: {
        clip: ["2", 0],
        text: "camera movement, zoom, pan, dark background, cast shadow, blurry, noise, artifact",
      },
    },
    "6": {
      class_type: "EmptyLatentImage",
      inputs: {
        batch_size: 8,
        height: 512,
        width: 512,
      },
    },
    "7": {
      class_type: "KSampler",
      inputs: {
        cfg: 2.0,
        denoise: 1.0,
        latent_image: ["6", 0],
        model: ["1", 0],
        negative: ["5", 0],
        positive: ["4", 0],
        sampler_name: "euler",
        scheduler: "normal",
        seed,
        steps,
      },
    },
    "8": {
      class_type: "VAEDecode",
      inputs: {
        samples: ["7", 0],
        vae: ["3", 0],
      },
    },
    "9": {
      class_type: "SaveImage",
      inputs: {
        filename_prefix: `spriteforge/moveset_${action}_${facing}`,
        images: ["8", 0],
      },
    },
  };

  // Connect reference images to LoadImage & MiniMaxH3MultiRefPacker
  const packerInputs: Record<string, any> = {};

  if (frontImage) {
    nodes["load_front"] = {
      class_type: "LoadImage",
      inputs: { image: frontImage },
    };
    packerInputs["image_1"] = ["load_front", 0];
  }

  if (sideImage) {
    nodes["load_side"] = {
      class_type: "LoadImage",
      inputs: { image: sideImage },
    };
    packerInputs["image_2"] = ["load_side", 0];
  }

  if (backImage) {
    nodes["load_back"] = {
      class_type: "LoadImage",
      inputs: { image: backImage },
    };
    packerInputs["image_3"] = ["load_back", 0];
  }

  if (Object.keys(packerInputs).length > 0) {
    nodes["ref_packer"] = {
      class_type: "MiniMaxH3MultiRefPacker",
      inputs: packerInputs,
    };
  }

  return nodes;
}

export function buildMovesetGraph(opts: MultiRefMovesetGraphOpts): Record<string, any> {
  return buildMultiRefMovesetGraph(opts);
}
