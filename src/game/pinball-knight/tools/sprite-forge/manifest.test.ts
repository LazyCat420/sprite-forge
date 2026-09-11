/**
 * THE VOTE: which clips get to decide how big a creature is.
 *
 * `aliveScale` used to exclude only `death`, and the same defect survived
 * unmeasured in `attack` — the jester's spring extends to 216px against a 177px
 * idle, so one transient frame was scaling all twenty and the frames the player
 * watches paid for it.
 *
 * These cases pin the rule in both directions: a transient must NOT shrink the
 * locomotion clips, and the fallbacks must never produce an empty vote.
 */
import { describe, it, expect } from "vitest";
import { aliveScale, artScale, cellScale, ART_FIT_H, ART_BOX } from "./manifest";
import type { ManifestRow } from "./manifest";
import type { Cell } from "./slice";

/** A row of `n` identical cells `w`×`h`. */
const row = (clip: string, w: number, h: number, n = 2): ManifestRow => ({
  clip,
  cells: Array.from({ length: n }, (_, i): Cell => [i * (w + 4), 0, i * (w + 4) + w - 1, h - 1]),
});

/** The shipped jester's real cell extents, per clip. */
const JESTER: ManifestRow[] = [
  row("idle", 150, 177), row("attack", 163, 216), row("walk", 167, 183),
  row("stumble", 176, 187), row("death", 201, 185),
];

describe("aliveScale — the locomotion vote", () => {
  it("a tall ATTACK does not shrink idle and walk", () => {
    // The defect this was changed for: without the fix the 216px attack sets
    // the scale and every other frame is 18% smaller.
    const withAttack = artScale(JESTER.filter((r) => r.clip !== "death").flatMap((r) => r.cells));
    const voted = aliveScale(JESTER);
    expect(voted).toBeGreaterThan(withAttack);
    expect(voted / withAttack).toBeGreaterThan(1.15); // measured +18%
  });

  it("a flat DEATH sprawl still does not shrink them either", () => {
    // The ORIGINAL defect, which must stay fixed.
    const noDeath = aliveScale(JESTER.filter((r) => r.clip !== "death"));
    expect(aliveScale(JESTER)).toBeCloseTo(noDeath, 10);
  });

  it("only locomotion votes — stumble cannot set the scale", () => {
    const a = aliveScale([row("idle", 100, 100), row("walk", 100, 100)]);
    const b = aliveScale([row("idle", 100, 100), row("walk", 100, 100), row("stumble", 300, 300)]);
    expect(b).toBeCloseTo(a, 10);
  });

  it("ANTI-VACUITY: a bigger IDLE still moves the scale", () => {
    // Otherwise everything above would pass on a function that ignores its input.
    const small = aliveScale([row("idle", 100, 100)]);
    const big = aliveScale([row("idle", 200, 200)]);
    expect(big).toBeLessThan(small);
  });

  it("falls back to all-but-death when no locomotion clip is named", () => {
    // Unnamed rows (`row0`, `row1`) cannot be classified, so the old rule
    // applies rather than an empty vote.
    const rows = [row("row0", 100, 100), row("row1", 120, 120)];
    expect(aliveScale(rows)).toBeCloseTo(artScale(rows.flatMap((r) => r.cells)), 10);
  });

  it("falls back to EVERYTHING rather than dividing by an empty vote", () => {
    const k = aliveScale([row("death", 100, 100)]);
    expect(Number.isFinite(k)).toBe(true);
    expect(k).toBeGreaterThan(0);
  });

  it("the clamped transient stays inside the cel, and the pulse is sub-texel", () => {
    // The COST of the rule, pinned. 9.1% of scale on the jester's attack is
    // 0.7 texels of head — bounded, and why the trade is worth making.
    const k = aliveScale(JESTER);
    const attack = JESTER.find((r) => r.clip === "attack")!.cells[0];
    const kc = cellScale(attack, k);
    expect(kc).toBeLessThanOrEqual(k);
    expect((attack[3] - attack[1] + 1) * kc).toBeLessThanOrEqual(ART_BOX);
    const HEAD = 26; // HEAD_R * 2, cel units — a size-invariant feature
    expect(Math.abs(HEAD * k - HEAD * kc) * (63 / ART_BOX)).toBeLessThan(1);
  });

  it("every clip still fits the cel after the increase", () => {
    const k = aliveScale(JESTER);
    for (const r of JESTER) {
      const c = r.cells[0];
      expect((c[3] - c[1] + 1) * cellScale(c, k)).toBeLessThanOrEqual(ART_BOX);
    }
    const idle = JESTER[0].cells[0];
    expect((idle[3] - idle[1] + 1) * k).toBeLessThanOrEqual(ART_FIT_H + 0.001);
  });
});
