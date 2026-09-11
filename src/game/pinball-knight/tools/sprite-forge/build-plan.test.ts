/**
 * The plan is the thing that decides what 40 minutes of GPU gets spent on, so
 * its refusals matter more than its successes. Most of these assert that a
 * malformed plan dies at PLAN time — before any weight loads — rather than
 * producing a sheet the importer drops in silence half an hour later.
 */
import { describe, it, expect } from "vitest";
import {
  planBuild, jobOrder, blockers, deriveState, rowKey,
  CAMERA_BY_DIR, BUILD_DIRS, DEFAULT_CLIPS, type ClipSpec,
} from "./build-plan";
import type { QaVerdict } from "./intake-qa";

const AT = 1_700_000_000_000;
const mk = (over: Partial<Parameters<typeof planBuild>[0]> = {}) =>
  planBuild({ id: "b1", name: "swamp_frog", createdAt: AT, ...over });

const verdict = (level: QaVerdict["level"]): QaVerdict => ({ level, checks: [], report: "" });

describe("planBuild", () => {
  it("refuses a name the stager would reject", () => {
    // `opStage` validates /^[a-z0-9_]+(-[ENS])?$/. Catching it here means the
    // failure lands on the form field, not after the art exists.
    expect(() => mk({ name: "Swamp Frog" })).toThrow(/publishable sheet name/);
    expect(() => mk({ name: "frog-E" })).toThrow(/publishable sheet name/);
    expect(() => mk({ name: "" })).toThrow(/publishable sheet name/);
  });

  it("refuses a clip the animator does not pack", () => {
    // `hurt` is THE trap: it is what every reference sheet prints above that
    // row, and the importer drops it with a warning nobody reads. The engine
    // calls it `stumble`.
    const clips = [{ clip: "hurt", move: "stumble", keys: 4, required: false }] as unknown as ClipSpec[];
    expect(() => mk({ clips })).toThrow(/not a clip the animator packs/);
  });

  it("refuses a plan with no idle", () => {
    const clips: ClipSpec[] = [{ clip: "walk", move: "walk", keys: 4, required: false }];
    expect(() => mk({ clips })).toThrow(/idle/);
  });

  it("refuses to skip E, the master's own facing", () => {
    expect(() => mk({ facings: ["S", "N"] })).toThrow(/E is the master's own facing/);
  });

  it("creates one row per clip per facing", () => {
    const b = mk();
    expect(Object.keys(b.rows)).toHaveLength(DEFAULT_CLIPS.length * BUILD_DIRS.length);
    expect(b.rows[rowKey("idle", "E")]).toMatchObject({ clip: "idle", dir: "E", state: "pending" });
  });

  it("never authors W", () => {
    // The engine flips E for west. Authoring it pays for art the game discards.
    expect(BUILD_DIRS).not.toContain("W");
    expect(Object.keys(CAMERA_BY_DIR).sort()).toEqual(["E", "N", "S"]);
  });
});

describe("camera", () => {
  it("gives every facing exactly one camera", () => {
    // The whole point of moving camera off the move: an E build is side-on for
    // idle AND attack, so the creature cannot teleport between clips.
    for (const d of BUILD_DIRS) expect(CAMERA_BY_DIR[d]).toBeTruthy();
    expect(CAMERA_BY_DIR.E).toMatch(/side view/);
    expect(CAMERA_BY_DIR.S).toMatch(/front view/);
    expect(CAMERA_BY_DIR.N).toMatch(/back view/);
  });
});

describe("jobOrder", () => {
  it("groups a facing's clips together and leads with idle", () => {
    const order = jobOrder(mk());
    expect(order[0]).toMatchObject({ clip: "idle", dir: "E" });
    // All of E before any of S — a facing is the unit a human reviews.
    const dirs = order.map((r) => r.dir);
    expect(dirs.indexOf("S")).toBeGreaterThan(dirs.lastIndexOf("E"));
    expect(dirs.indexOf("N")).toBeGreaterThan(dirs.lastIndexOf("S"));
  });

  it("emits every row exactly once", () => {
    const b = mk();
    const order = jobOrder(b);
    expect(order).toHaveLength(Object.keys(b.rows).length);
    expect(new Set(order.map((r) => rowKey(r.clip, r.dir))).size).toBe(order.length);
  });
});

describe("blockers", () => {
  it("reports a missing master per facing", () => {
    const out = blockers(mk());
    expect(out).toContain("no approved master for facing E");
    expect(out).toContain("no approved master for facing N");
  });

  it("reports EVERY problem, not just the first", () => {
    // A user who fixes one thing and is handed the next one is being drip-fed.
    const b = mk();
    b.rows[rowKey("idle", "E")].verdicts = [verdict("reject"), verdict("ready")];
    const out = blockers(b);
    expect(out.length).toBeGreaterThan(2);
    expect(out.some((s) => /idle E has 1 cell/.test(s))).toBe(true);
  });

  it("holds idle to the required bar even when other clips are done", () => {
    const b = mk();
    for (const d of BUILD_DIRS) b.masters[d] = { jobId: "j", frame: "f", qa: verdict("ready") };
    for (const r of Object.values(b.rows)) r.state = "approved";
    expect(blockers(b)).toEqual([]);
    b.rows[rowKey("idle", "S")].state = "failed";
    expect(blockers(b)).toContain("idle S is required and is failed");
  });
});

describe("deriveState", () => {
  const withMasters = () => {
    const b = mk();
    for (const d of BUILD_DIRS) b.masters[d] = { jobId: "j", frame: "f", qa: verdict("ready") };
    return b;
  };

  it("is draft until E has a master", () => {
    expect(deriveState(mk())).toBe("draft");
  });

  it("is master-approved when E is in but the other facings are not", () => {
    const b = mk();
    b.masters.E = { jobId: "j", frame: "f", qa: verdict("ready") };
    expect(deriveState(b)).toBe("master-approved");
  });

  it("walks planned → generating → review → assembled", () => {
    const b = withMasters();
    expect(deriveState(b)).toBe("planned");
    b.rows[rowKey("idle", "E")].state = "running";
    expect(deriveState(b)).toBe("generating");
    b.rows[rowKey("idle", "E")].state = "review";
    expect(deriveState(b)).toBe("review");
    for (const r of Object.values(b.rows)) r.state = "approved";
    expect(deriveState(b)).toBe("assembled");
  });

  it("never walks back out of published", () => {
    // Derivation is a convenience, not an authority over a fact on disk. Once
    // bytes are in public/sprites/, a row going stale must not un-publish them.
    const b = withMasters();
    b.state = "published";
    expect(deriveState(b)).toBe("published");
  });
});
