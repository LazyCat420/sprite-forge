/**
 * ONE CLIP CONTRACT, THREE LISTS THAT HAD ALREADY DRIFTED.
 *
 * `camera-sync.test.ts` exists because `comfy/modes.mjs` (plain ESM the API
 * route imports) and `build-plan.ts` (TypeScript) cannot import each other, so
 * the camera table is written twice. **The clip set is written THREE times and
 * had no such test**, and on 2026-08-08 the copies were measured apart:
 *
 *     MOVESET        idle walk run attack stumble crouch death   (7)
 *     KEYFRAME_SET   idle walk run attack stumble ______ death   (6)
 *     DEFAULT_CLIPS  idle walk run attack stumble ______ death   (6)
 *
 * and the comment introducing `DEFAULT_CLIPS` asserted, in prose, that all
 * three agreed *"because two lists of what a character needs is how they drift
 * apart"* — while naming `crouch` as part of the mapping it did not contain.
 * A comment that claims an invariant is not an invariant. This file is.
 *
 * ── WHY IT COMPARES THE BATCHES AND NOT THE LISTS ───────────────────────────
 *
 * It reads what the panel's one-click batch would actually enqueue — the batch
 * values resolved through each mode's own preset table — rather than importing
 * three arrays. The arrays are the thing under test; a batch nobody can run is
 * not made correct by the array behind it being right, and this way the test
 * fails if the batch is filtered differently from the list too.
 *
 * ── AND WHY `crouch` IS THE ONE THAT MATTERS ────────────────────────────────
 *
 * `render/tell-clips.ts` maps three movement telegraphs onto clips. Only one
 * has no fallback anywhere:
 *
 *     crouch  leaper          NO fallback — CLIP_FALLBACK sends it to `idle`
 *     wake    ambusher/strafer  cel-painter.ts synthesizes one from the walk
 *     wait    packhunter        no kind uses packhunter (see below)
 *
 * So an unauthored `crouch` is a telegraph that silently does not play, which
 * is exactly what shipped until `97eb184`.
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_CLIPS } from "./build-plan";
import { MODES } from "./comfy/modes.mjs";
import { MOVEMENT_BY_KIND } from "../../entities/enemy-rules";
import { MOVEMENT_HANDLERS } from "../../entities/movement";

type Preset = { id: string; clip?: string };
type Mode = {
  id: string;
  presets?: Preset[] | null;
  batch?: { values: Array<Record<string, unknown>> } | null;
};

/** The clips a mode's one-click batch would file frames under, in batch order. */
function batchClips(modeId: string): string[] {
  const mode = (MODES as Mode[]).find((m) => m.id === modeId);
  if (!mode) throw new Error(`no mode "${modeId}"`);
  if (!mode.batch) throw new Error(`mode "${modeId}" has no batch`);
  return mode.batch.values.map((v) => {
    const preset = mode.presets?.find((p) => p.id === v.preset);
    if (!preset) throw new Error(`mode "${modeId}" batches preset "${v.preset}" which its own preset table lacks`);
    if (!preset.clip) throw new Error(`preset "${preset.id}" of mode "${modeId}" files under no clip`);
    return preset.clip;
  });
}

const planClips = DEFAULT_CLIPS.map((c) => c.clip);

describe("the clip set", () => {
  it("is the same set in the animate batch, the keyframe batch and the build plan", () => {
    const animate = [...new Set(batchClips("animate"))].sort();
    const keyframes = [...new Set(batchClips("keyframes"))].sort();
    const plan = [...planClips].sort();

    // Compared to EACH OTHER, never to a restatement — a fourth hand-written
    // copy inside a test is a fourth thing to go stale, and it would keep
    // passing while all three real copies moved together.
    expect(animate).toEqual(plan);
    expect(keyframes).toEqual(plan);
  });

  it("authors every telegraph clip that has no fallback", () => {
    // `crouch` is the whole reason this file exists. Deleting it from
    // DEFAULT_CLIPS must fail here even if someone also deletes it from both
    // mjs lists, which the agreement test above would then call consistent.
    expect(planClips).toContain("crouch");
  });

  it("still requires an idle — a sheet without one is dropped in silence", () => {
    expect(DEFAULT_CLIPS.find((c) => c.clip === "idle")?.required).toBe(true);
  });

  it("files the stagger under `stumble` and the block under `crouch`", () => {
    // The two mappings the old comment named. They are the ones where the
    // generation-side id and the game-side clip differ, so they are the two a
    // rename would silently break.
    const bySpec = new Map(DEFAULT_CLIPS.map((c) => [c.move, c.clip]));
    expect(bySpec.get("stumble")).toBe("stumble");
    expect(bySpec.get("defend")).toBe("crouch");
  });
});

describe("packhunter", () => {
  /**
   * A DECISION, RECORDED AS A TEST RATHER THAN A COMMENT.
   *
   * `packhunter` is a fully implemented movement policy — it raises
   * `MOVE_TELL.pack`, which `clipForSteer` resolves to the clip `wait` — and no
   * `EnemyKind` uses it. That is fine as a shelf item, and it is NOT fine
   * silently: the day a kind is assigned it inherits a clip demand that neither
   * the forge nor any painter authors, and `wait` has no fallback, so it would
   * play `idle` exactly like the hound's crouch did.
   *
   * So this asserts the shelf. Assigning `packhunter` to a kind fails here,
   * and the failure message is the instruction.
   */
  it("has no kind, and acquiring one means authoring `wait` first", () => {
    expect(MOVEMENT_HANDLERS).toHaveProperty("packhunter");
    const users = Object.entries(MOVEMENT_BY_KIND)
      .filter(([, policy]) => policy === "packhunter")
      .map(([kind]) => kind);
    expect(
      users,
      `packhunter is now used by [${users.join(", ")}]. Its telegraph resolves to the clip "wait", which ` +
        "nothing authors and CLIP_FALLBACK sends to `idle` — so the stalk would be invisible. Author `wait` " +
        "for these kinds (painter or sheet), add it to DEFAULT_CLIPS + both modes.mjs lists, then update this test.",
    ).toEqual([]);
  });
});
