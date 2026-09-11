/**
 * THE SMALL ANIMATION LEG — TI2V-5B instead of the A14B expert pair.
 *
 * These are structural assertions about a graph, which is the only honest thing
 * to test here: a graph test cannot tell you the frames are good, and this repo
 * has been burned twice by treating a passing check as evidence about art. What
 * it CAN tell you is that the wiring says what the leg claims — one model not
 * two, the 2.2 VAE not the 2.1, no LoRA that cannot load, and a loud refusal
 * where the small leg genuinely cannot do the job.
 *
 * ⚠️ NOTHING HERE HAS RENDERED A FRAME. The 5B weights are a 5.4GB download
 * that has not happened; `smallAvailable()` returns false until it does, so the
 * leg is registered and unreachable by default. Read every claim below as "the
 * graph is shaped correctly", never as "the leg works".
 */
import { describe, it, expect } from "vitest";
import { wanI2V, wanTi2v5B, MODELS, A14B_ONLY_LORAS, WAN_NEGATIVE } from "./comfy/graphs.mjs";
import { modeById } from "./comfy/modes.mjs";

/**
 * `any` because `graphs.mjs` is plain ESM: TS infers a destructured parameter's
 * type from its DEFAULTS, and `image`/`prompt` have none (they are required and
 * throw when absent), so they do not appear in the inferred shape at all and no
 * caller can pass them type-safely. Widening here rather than adding a JSDoc
 * signature to a 130-line builder is deliberate — the check that matters in
 * this file is the graph's structure, not its call signature.
 */
const base: any = { image: "init.png", prompt: "a pixel art hound walking" };

describe("the TI2V-5B graph", () => {
  it("loads ONE diffusion model where the A14B pair loads two", () => {
    const small = wanTi2v5B(base);
    const big = wanI2V(base);
    const loaders = (g: Record<string, { class_type: string }>) =>
      Object.values(g).filter((n) => n.class_type === "UnetLoaderGGUF").length;
    expect(loaders(big)).toBe(2);
    expect(loaders(small)).toBe(1);
  });

  it("runs ONE sampler over the whole schedule, not two half-schedules", () => {
    // The A14B split exists because its experts are noise-specialised. A dense
    // model handed a half-schedule would denoise to noise, so this is a
    // correctness assertion and not a tidiness one.
    const g = wanTi2v5B(base);
    const kinds = Object.values(g).map((n: any) => n.class_type);
    expect(kinds).toContain("KSampler");
    expect(kinds).not.toContain("KSamplerAdvanced");
  });

  it("takes the 2.2 VAE — pairing it with the 2.1 VAE decodes to garbage", () => {
    const g: any = wanTi2v5B(base);
    expect(g.v.inputs.vae_name).toBe(MODELS.wanVae22);
    expect(g.v.inputs.vae_name).not.toBe(MODELS.wanVae);
    // …and the A14B leg must NOT have moved with it.
    expect((wanI2V(base) as any).v.inputs.vae_name).toBe(MODELS.wanVae);
  });

  it("conditions the sampler directly — the 2.2 latent node carries no conditioning", () => {
    // `WanImageToVideo` returns (positive, negative, latent), so the A14B graph
    // routes text through it. `Wan22ImageToVideoLatent` returns a latent only.
    // Wiring 5B the A14B way would silently drop the prompt.
    const g: any = wanTi2v5B(base);
    expect(g.lat.class_type).toBe("Wan22ImageToVideoLatent");
    expect(g.k.inputs.positive).toEqual(["pos", 0]);
    expect(g.k.inputs.negative).toEqual(["neg", 0]);
    expect(g.k.inputs.latent_image).toEqual(["lat", 0]);
    expect(g.lat.inputs.start_image).toEqual(["img", 0]);
  });

  it("shares the measured Wan negative with the A14B leg rather than restating it", () => {
    const small: any = wanTi2v5B(base);
    const big: any = wanI2V(base);
    expect(small.neg.inputs.text).toBe(big.neg.inputs.text);
    expect(small.neg.inputs.text).toBe(WAN_NEGATIVE);
  });

  it("keeps the decode fence — the RAM cliff is smaller here, not absent", () => {
    const g: any = wanTi2v5B(base);
    expect(g.purge.class_type).toBe("VRAM_Debug");
    expect(g.purge.inputs.unload_all_models).toBe(true);
    // The decode must read the FENCED latent, not the sampler directly — that
    // ordering is the whole point of the fence.
    expect(g.dec.inputs.samples).toEqual(["purge", 0]);
    expect(g.dec.class_type).toBe("VAEDecodeTiled");
  });
});

describe("what the small leg refuses", () => {
  it("REFUSES an A14B LoRA instead of silently loading one that cannot bind", () => {
    // The silent version is the dangerous one: a LoRA that "applied" and did
    // nothing looks exactly like a LoRA that is not working, and the last time
    // this pipeline could not tell those apart it cost a session.
    for (const frag of A14B_ONLY_LORAS) {
      expect(() => wanTi2v5B({ ...base, loras: [{ name: `${frag}_something.safetensors`, strength: 0.8 }] })).toThrow(
        /A14B adapter|cannot load/i,
      );
    }
  });

  it("allows a LoRA that is not on the A14B list", () => {
    // The guard must not be a blanket ban — the day a 5B pixel adapter exists,
    // this is the path it rides in on.
    const g: any = wanTi2v5B({ ...base, loras: [{ name: "some_5b_pixel_lora.safetensors", strength: 0.7 }] });
    const lora = Object.values(g).find((n: any) => n.class_type === "LoraLoaderModelOnly") as any;
    expect(lora.inputs.lora_name).toBe("some_5b_pixel_lora.safetensors");
    // Chain discipline: the shift must wrap the PATCHED model, same as A14B.
    expect(g.s.inputs.model).toEqual(["l0", 0]);
  });

  it("refuses a size off the 32px grid rather than being silently rounded", () => {
    expect(() => wanTi2v5B({ ...base, width: 570, height: 640 })).toThrow(/32px grid/);
    expect(() => wanTi2v5B({ ...base, width: 640, height: 640 })).not.toThrow();
  });

  it("keeps the 4k+1 frame rule", () => {
    expect(() => wanTi2v5B({ ...base, length: 20 })).toThrow(/4k\+1/);
    expect(() => wanTi2v5B({ ...base, length: 21 })).not.toThrow();
  });

  /**
   * ⚠️ THE TWO LEGS DO NOT ACCEPT THE SAME CANVAS, AND THE PLAN'S NUMBER IS
   * ONLY LEGAL ON ONE OF THEM. Found by this test failing on its first run.
   *
   *   WanImageToVideo        (A14B)  width/height step 16  → 560 is fine
   *   Wan22ImageToVideoLatent (5B)   width/height step 32  → 560 is NOT
   *
   * `PLAN_KEYFRAME_PIPELINE.md` says to generate the master at 560px "so a
   * 560px canvas is ×8 and reduces exactly". The ×8 arithmetic is right —
   * 560/8 = 70 texels — but 560/32 = 17.5, so on the small leg that size is off
   * the grid and would be silently rounded by the sampler, arriving as frames a
   * different shape than the cut was planned for.
   *
   * 576 satisfies BOTH: 576/32 = 18 and 576/8 = 72 texels, which is the
   * documented texel budget exactly. 544 is the other legal neighbour at 68.
   */
  it("takes 576 (72 texels) but NOT the plan's 560 — the two legs differ here", () => {
    const g: any = wanTi2v5B({ ...base, width: 576, height: 576 });
    expect(g.lat.inputs.width).toBe(576);
    expect(576 % 32).toBe(0);
    expect(576 / 8).toBe(72);

    expect(() => wanTi2v5B({ ...base, width: 560, height: 560 })).toThrow(/32px grid/);
    // …and the A14B leg genuinely does accept it, so this is a leg difference
    // and not a mistake in the plan's arithmetic.
    expect(() => wanI2V({ ...base, width: 560, height: 560 })).not.toThrow();
  });
});

/**
 * THE TRIGGER WORD AND THE LoRA ARE ONE DECISION.
 *
 * Caught on the first real 5B run (2026-08-08): the prompt went out as
 * `pix3lwalk, Pixel art game sprite walking…` on a leg that had REFUSED to load
 * `pix3lwalk`. `ctx.has()` answers "is the weight on disk", which is not the
 * same question as "will this run attach it".
 *
 * It reads as cosmetic and is not. A trigger is a token the model associates
 * with weights that are absent, so it is noise in the conditioning — and worse,
 * it makes an A/B between the two legs invalid, because the arms would differ by
 * a prompt as well as by a model. Every measurement in this pipeline is a
 * one-variable comparison; a stray token in one arm silently costs a run.
 */
describe("the pix3lwalk trigger", () => {
  const animate = modeById("animate") as any;
  const ctxFor = (over: Record<string, unknown> = {}) => ({
    has: () => true, // every weight installed — the interesting axis is the LEG
    lora: (id: string) => `${id}.safetensors`,
    unet: () => "unet.gguf",
    chosen: () => null,
    fileOf: (id: string) => `${id}.safetensors`,
    fast: false,
    small: false,
    images: { init: "init.png" },
    seed: 7,
    ...over,
  });

  it("rides along on the A14B leg, where the LoRA actually loads", () => {
    expect(animate.prompt({ preset: "walk" }, ctxFor())).toMatch(/^pix3lwalk, /);
  });

  it("is DROPPED on the small leg, where the LoRA is refused", () => {
    expect(animate.prompt({ preset: "walk" }, ctxFor({ small: true }))).not.toMatch(/pix3lwalk/);
  });

  it("is dropped when the weight is simply not installed", () => {
    expect(animate.prompt({ preset: "walk" }, ctxFor({ has: () => false }))).not.toMatch(/pix3lwalk/);
  });

  it("covers walk4 too — it is a walk, and the test is keyed on the CLIP", () => {
    expect(animate.prompt({ preset: "walk4" }, ctxFor())).toMatch(/^pix3lwalk, /);
    expect(animate.prompt({ preset: "walk4" }, ctxFor({ small: true }))).not.toMatch(/pix3lwalk/);
  });

  it("never rides a non-walk preset", () => {
    for (const preset of ["idle", "attack", "death", "defend"]) {
      expect(animate.prompt({ preset }, ctxFor()), preset).not.toMatch(/pix3lwalk/);
    }
  });
});
