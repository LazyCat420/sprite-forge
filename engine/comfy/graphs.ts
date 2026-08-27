/**
 * DGX Spark ComfyUI API Graph Builders for Sprite Forge.
 * Matched to exact models installed on Gold Spark & MSI Spark (128GB unified memory).
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
}

export function buildTurnaroundGraph({
  facing,
  character,
  seed = Math.floor(Math.random() * 1e9),
}: TurnaroundGraphOpts): Record<string, any> {
  const facingText =
    facing === "E"
      ? "side profile facing right"
      : facing === "N"
        ? "back view facing away from camera"
        : "front facing toward camera";

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
        text: `pixel art sprite of ${character}, ${facingText}, matching palette and silhouette, solid flat green chroma background, centered full body`,
      },
    },
    "5": {
      class_type: "CLIPTextEncode",
      inputs: {
        clip: ["2", 0],
        text: "blurry, photorealistic, noise, dark background, cast shadow",
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
        filename_prefix: `spriteforge/turnaround_${facing}`,
        images: ["8", 0],
      },
    },
  };
}
