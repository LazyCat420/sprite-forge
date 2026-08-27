/**
 * DGX Spark ComfyUI API Graph Builders for Sprite Forge.
 * Matched to exact models installed on Gold Spark & MSI Spark (128GB unified memory).
 * 
 * - Concept Intake: Krea2 Turbo FP8 + Qwen3VL 4B + Qwen VAE (Fast initial concept exploration)
 * - 3-Way Turnaround: MiniMax H3 Ref2VA INT8 + Qwen3VL 32B + MiniMax Video VAE (Reference Identity & True 3D Rotation)
 * - Moveset Matrix: MiniMax H3 FL2VA INT8 + Qwen3VL 32B + MiniMax Video VAE (Video Moveset Animation)
 */

export interface ConceptGraphOpts {
  prompt: string;
  negativePrompt?: string;
  seed?: number;
  width?: number;
  height?: number;
  steps?: number;
  cfg?: number;
}

export function buildConceptGraph({
  prompt,
  negativePrompt = "blurry, photorealistic, noise, dark background, cast shadow, extra limbs, deformed",
  seed = Math.floor(Math.random() * 1e9),
  width = 512,
  height = 768,
  steps = 8,
  cfg = 2.0,
}: ConceptGraphOpts): Record<string, any> {
  return {
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
}

export interface TurnaroundGraphOpts {
  image?: string;
  facing: "S" | "E" | "N";
  character: string;
  seed?: number;
  denoise?: number;
}

/**
 * MiniMax H3 Ref2VA Turnaround Graph.
 * Uses 32B MiniMax CLIP and Ref2VA UNET with ReferenceLatent cross-attention
 * to preserve armor style, proportions, and palette while rotating to side/back views.
 */
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

  // If init reference image is provided, use MiniMax H3 Ref2VA with ReferenceLatent
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

  // Fallback if no reference image
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

export interface MovesetGraphOpts {
  character: string;
  action: string;
  facing: "S" | "E" | "N";
  seed?: number;
  steps?: number;
}

/**
 * MiniMax H3 Video Moveset Graph (Visual-Only: Audio Omitted for Peak Speed & VRAM efficiency).
 */
export function buildMovesetGraph({
  character,
  action,
  facing,
  seed = Math.floor(Math.random() * 1e9),
  steps = 8,
}: MovesetGraphOpts): Record<string, any> {
  const facingText = facing === "E" ? "side view" : facing === "N" ? "back view" : "front view";

  return {
    "1": {
      class_type: "UNETLoader",
      inputs: {
        unet_name: "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
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
        text: `pixel art animation clip of ${character} performing ${action}, ${facingText}, solid flat green chroma background, locked camera, seamless sprite motion`,
      },
    },
    "5": {
      class_type: "CLIPTextEncode",
      inputs: {
        clip: ["2", 0],
        text: "camera movement, zoom, pan, dark background, cast shadow, blurry, noise",
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
}
