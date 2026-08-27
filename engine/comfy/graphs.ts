/**
 * API-format graph builders for Sprite Forge targeting ComfyUI on DGX Spark.
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
  negativePrompt = "blurry, photorealistic, noise, 3d render, watermark, extra limbs, dark background, cast shadow",
  seed = Math.floor(Math.random() * 1e9),
  width = 512,
  height = 768,
  steps = 20,
  cfg = 7.0,
}: ConceptGraphOpts): Record<string, any> {
  return {
    "1": {
      class_type: "KSampler",
      inputs: {
        cfg,
        denoise: 1,
        latent_image: ["2", 0],
        model: ["4", 0],
        negative: ["6", 0],
        positive: ["5", 0],
        sampler_name: "euler",
        scheduler: "normal",
        seed,
        steps,
      },
    },
    "2": {
      class_type: "EmptyLatentImage",
      inputs: {
        batch_size: 1,
        height,
        width,
      },
    },
    "4": {
      class_type: "CheckpointLoaderSimple",
      inputs: {
        ckpt_name: "v1-5-pruned-emaonly.safetensors",
      },
    },
    "5": {
      class_type: "CLIPTextEncode",
      inputs: {
        clip: ["4", 1],
        text: prompt + ", pixel art style, flat solid background, clear silhouette, centered full body sprite",
      },
    },
    "6": {
      class_type: "CLIPTextEncode",
      inputs: {
        clip: ["4", 1],
        text: negativePrompt,
      },
    },
    "7": {
      class_type: "VAEDecode",
      inputs: {
        samples: ["1", 0],
        vae: ["4", 2],
      },
    },
    "8": {
      class_type: "SaveImage",
      inputs: {
        filename_prefix: "spriteforge/concept",
        images: ["7", 0],
      },
    },
  };
}

export interface TurnaroundGraphOpts {
  image: string;
  facing: "S" | "E" | "N";
  character: string;
  seed?: number;
}

export function buildTurnaroundGraph({
  image,
  facing,
  character,
  seed = Math.floor(Math.random() * 1e9),
}: TurnaroundGraphOpts): Record<string, any> {
  const facingText =
    facing === "E" ? "side profile facing right" : facing === "N" ? "back view facing away from camera" : "front facing toward camera";

  return {
    "1": {
      class_type: "LoadImage",
      inputs: { image },
    },
    "2": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: "v1-5-pruned-emaonly.safetensors" },
    },
    "3": {
      class_type: "CLIPTextEncode",
      inputs: {
        clip: ["2", 1],
        text: `pixel art sprite of ${character}, ${facingText}, matching reference style, same proportions, flat background`,
      },
    },
    "4": {
      class_type: "CLIPTextEncode",
      inputs: {
        clip: ["2", 1],
        text: "blurry, photorealistic, noise, extra limbs, dark background, cast shadow",
      },
    },
    "5": {
      class_type: "VAEEncode",
      inputs: { pixels: ["1", 0], vae: ["2", 2] },
    },
    "6": {
      class_type: "KSampler",
      inputs: {
        cfg: 7.0,
        denoise: 0.65,
        latent_image: ["5", 0],
        model: ["2", 0],
        negative: ["4", 0],
        positive: ["3", 0],
        sampler_name: "euler",
        scheduler: "normal",
        seed,
        steps: 20,
      },
    },
    "7": {
      class_type: "VAEDecode",
      inputs: { samples: ["6", 0], vae: ["2", 2] },
    },
    "8": {
      class_type: "SaveImage",
      inputs: { filename_prefix: `spriteforge/turnaround_${facing}`, images: ["7", 0] },
    },
  };
}
