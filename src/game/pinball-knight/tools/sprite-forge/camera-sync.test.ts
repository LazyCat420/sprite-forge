/**
 * ONE CAMERA CONTRACT, TWO FILES THAT CANNOT IMPORT EACH OTHER.
 *
 * `comfy/modes.mjs` is plain ESM the API route imports directly; `build-plan.ts`
 * is TypeScript. Making either import the other drags a build step into the
 * generation path, so the table is written twice — and a table written twice is
 * a table that drifts.
 *
 * This test is the seam. It compares the copies to each other rather than to a
 * restatement of the values, because a third hand-written copy inside a test is
 * just a third thing to go stale: it would keep passing while both real copies
 * moved together, and fail spuriously the moment someone reworded a camera.
 */
import { describe, it, expect } from "vitest";
import { CAMERA_BY_DIR as TS_CAMERAS, BUILD_DIRS } from "./build-plan";
// Plain ESM with no hand-written types — tsc infers them through allowJs.
import { CAMERA_BY_DIR as MJS_CAMERAS, KEYFRAME_FACINGS, MODES } from "./comfy/modes.mjs";

describe("the camera table", () => {
  it("is identical in modes.mjs and build-plan.ts", () => {
    expect(MJS_CAMERAS).toEqual(TS_CAMERAS);
  });

  it("covers exactly the facings a build authors", () => {
    expect(Object.keys(MJS_CAMERAS).sort()).toEqual([...BUILD_DIRS].sort());
    expect((KEYFRAME_FACINGS as { id: string }[]).map((f) => f.id).sort()).toEqual([...BUILD_DIRS].sort());
  });

  it("never authors W — the engine flips E for it", () => {
    expect(Object.keys(MJS_CAMERAS)).not.toContain("W");
  });
});

describe("the keyframes mode", () => {
  const keyframes = (MODES as { id: string }[]).find((m) => m.id === "keyframes") as unknown as {
    fields: { id: string; default?: string }[];
    prompt: (p: Record<string, unknown>) => string;
  };

  const cameraOf = (prompt: string): string => {
    const m = /SAME camera angle — (.+?) — the character never turns/.exec(prompt);
    if (!m) throw new Error(`no camera clause in prompt:\n${prompt}`);
    return m[1];
  };

  it("takes a facing, defaulting to the master's own", () => {
    const f = keyframes.fields.find((x) => x.id === "facing");
    expect(f, "keyframes must expose a facing — it is what picks the camera").toBeTruthy();
    expect(f?.default).toBe("E");
  });

  it("gives every move of a facing the SAME camera", () => {
    // The whole point. Walk and attack disagreeing is what made a creature
    // teleport the moment combat started.
    for (const dir of BUILD_DIRS) {
      const cams = ["idle", "walk", "run", "attack", "stumble", "death"].map((preset) =>
        cameraOf(keyframes.prompt({ preset, facing: dir })),
      );
      expect(new Set(cams).size, `facing ${dir} generated ${new Set(cams).size} cameras: ${[...new Set(cams)].join(" | ")}`).toBe(1);
      expect(cams[0]).toBe(TS_CAMERAS[dir]);
    }
  });

  it("still forbids turning between frames", () => {
    // The camera sentence is load-bearing: without the ban, an edit model
    // expresses a stride by ROTATING the character and the row comes back a
    // turnaround. Measured on the frog, 2026-08-05.
    const p = keyframes.prompt({ preset: "walk", facing: "E" });
    expect(p).toMatch(/never turns or rotates/);
    expect(p).toMatch(/feet on one shared baseline/);
  });

  it("falls back to E rather than dropping the clause on a bad facing", () => {
    // A missing camera sentence is the failure this whole table prevents, so an
    // unknown facing must degrade to a real camera, never to nothing.
    expect(cameraOf(keyframes.prompt({ preset: "walk", facing: "W" }))).toBe(TS_CAMERAS.E);
    expect(cameraOf(keyframes.prompt({ preset: "walk" }))).toBe(TS_CAMERAS.E);
  });
});
