/**
 * THE ROTATE PROMPT IS A TRAINED GRAMMAR, AND A TYPO IN IT FAILS SILENTLY.
 *
 * With `fal-multi-angle` installed, `rotate` stops emitting a sentence and
 * emits that LoRA's vocabulary instead: `<sks> [azimuth] [elevation]
 * [distance]`, 96 poses = 8 azimuths × 4 elevations × 3 distances, trained on
 * Gaussian-Splatting renders of one object so the identity holds as the camera
 * moves. That is the whole reason the LoRA is on disk — identity drift across
 * facings is what makes a three-facing sheet look like three animals.
 *
 * An untrained string does not error. It is simply a phrase the LoRA has
 * nothing to say about, so the base model does its freeform turning and the
 * run looks like it worked. There is no signal at generation time and the
 * damage shows up two facings later as drift, which is exactly the kind of
 * defect this repo has repeatedly paid for.
 *
 * ── WHY THIS TEST RESTATES THE VOCABULARY, WHEN `camera-sync.test.ts` REFUSES TO ──
 *
 * That test compares two in-repo copies to each other and says a third
 * hand-written copy would just be a third thing to go stale. Correct there,
 * wrong here: the authority for these tokens is NOT in this repo at all, it is
 * the LoRA's model card. Restating them is not duplicating our own logic, it is
 * writing down the external contract we are coding against — the only form in
 * which a mismatch can be detected. Comparing `modes.mjs` to itself would pass
 * on all eight tokens misspelled.
 *
 * Source: https://huggingface.co/fal/Qwen-Image-Edit-2511-Multiple-Angles-LoRA
 */
import { describe, it, expect } from "vitest";
import { FACINGS, MODES } from "./comfy/modes.mjs";
import { BUILD_DIRS } from "./build-plan";

/** The LoRA's eight trained azimuths, verbatim from its model card. */
const TRAINED_AZIMUTHS = [
  "front view",
  "front-right quarter view",
  "right side view",
  "back-right quarter view",
  "back view",
  "back-left quarter view",
  "left side view",
  "front-left quarter view",
];
/** Its four trained elevations and three trained distances. */
const TRAINED_ELEVATIONS = ["low-angle shot", "eye-level shot", "elevated shot", "high-angle shot"];
const TRAINED_DISTANCES = ["close-up", "medium shot", "wide shot"];

type Facing = { id: string; sks: string; phrase: string; diagonal?: boolean };
const facings = FACINGS as Facing[];

const rotate = (MODES as { id: string }[]).find((m) => m.id === "rotate") as unknown as {
  batch: { values: { facing: string }[] };
  prompt: (p: Record<string, unknown>, ctx: { has: (id: string) => boolean }) => string;
};

/** The two ctxs that matter: the LoRA present, and the LoRA absent. */
const WITH_LORA = { has: (id: string) => id === "fal-multi-angle" };
const NO_LORA = { has: () => false };

describe("the multi-angle vocabulary", () => {
  it("gives every facing a token the LoRA was actually trained on", () => {
    for (const f of facings) {
      expect(TRAINED_AZIMUTHS, `facing ${f.id} asks for "${f.sks}", which is not one of the LoRA's 8 azimuths`).toContain(
        f.sks,
      );
    }
  });

  it("never points two facings at the same azimuth", () => {
    const used = facings.map((f) => f.sks);
    expect(new Set(used).size, `duplicate azimuths: ${used.join(" | ")}`).toBe(used.length);
  });

  it("emits the grammar in the trained order — azimuth, elevation, distance", () => {
    for (const f of facings) {
      const p = rotate.prompt({ facing: f.id }, WITH_LORA);
      const m = /^<sks> (.+?) (low-angle shot|eye-level shot|elevated shot|high-angle shot) (close-up|medium shot|wide shot)\b/.exec(p);
      expect(m, `facing ${f.id} did not emit "<sks> [azimuth] [elevation] [distance]":\n${p}`).toBeTruthy();
      expect(m?.[1]).toBe(f.sks);
      expect(TRAINED_ELEVATIONS).toContain(m?.[2]);
      expect(TRAINED_DISTANCES).toContain(m?.[3]);
    }
  });

  it("drops to the freeform sentence — not to a broken `<sks>` — with no LoRA", () => {
    // The fallback has to be a prompt the BASE model understands. An `<sks>`
    // string with no LoRA loaded is a nonsense token, which is worse than the
    // sentence it replaced.
    const p = rotate.prompt({ facing: "S" }, NO_LORA);
    expect(p).not.toContain("<sks>");
    expect(p).toContain(facings.find((f) => f.id === "S")?.phrase);
  });
});

describe("the facings the engine can consume", () => {
  it("authors every game direction, and none of them is a diagonal", () => {
    for (const dir of BUILD_DIRS) {
      const f = facings.find((x) => x.id === dir);
      expect(f, `no FACINGS row for the engine direction ${dir}`).toBeTruthy();
      expect(f?.diagonal, `${dir} is a game facing and must not be flagged diagonal`).toBeFalsy();
    }
  });

  it("keeps diagonals out of the three-facing batch", () => {
    // The diagonals exist so the question "can we even make them" is answered
    // by the table (the LoRA was trained on all eight). But `Dir` is
    // "S" | "N" | "E", so a batch that swept one up would spend a run on art
    // nothing can draw.
    const batched = rotate.batch.values.map((v) => v.facing);
    for (const id of batched) {
      expect(facings.find((f) => f.id === id)?.diagonal, `the rotate batch includes the diagonal ${id}`).toBeFalsy();
    }
    expect(batched.sort()).toEqual([...BUILD_DIRS].sort());
  });

  it("flags as diagonal exactly the quarter views", () => {
    // The link between the two vocabularies: a "quarter view" azimuth is a
    // diagonal facing and nothing else is. If someone adds an azimuth without
    // the flag, the batch check above stops protecting anything.
    for (const f of facings) {
      expect(Boolean(f.diagonal), `${f.id} ("${f.sks}") is flagged ${f.diagonal ? "" : "not "}diagonal`).toBe(
        f.sks.includes("quarter view"),
      );
    }
  });
});
