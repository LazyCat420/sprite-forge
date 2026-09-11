/**
 * The banner's clock must be a clock.
 *
 * The bug this pins shipped and was invisible to an API check: the live banner
 * computed elapsed as `tick - startedAt`, where `tick` is `useState(0)` — a
 * re-render counter that busts the preview image cache, not a timestamp. A
 * small integer minus a millisecond epoch is hugely negative, `Math.max(0, …)`
 * clamped it, and the banner showed 0m00s forever. It was caught by
 * screenshotting the page and seeing 0m00s directly above a JobCard reading
 * 81s for the same job.
 *
 * So the case that matters is "a tick-like small number is not a time", and it
 * is asserted directly rather than implied.
 */
import { describe, expect, it } from "vitest";
import { elapsedSecs, formatElapsed } from "./JobsBoard";

const NOW = 1_754_690_000_000;

describe("elapsedSecs", () => {
  it("measures against the wall clock, not a render counter", () => {
    expect(elapsedSecs(NOW - 81_000, NOW)).toBe(81);
    expect(elapsedSecs(NOW - 600_000, NOW)).toBe(600);
  });

  it("does not silently clamp a real duration to zero", () => {
    // The shipped bug's signature: a plausible-looking call that returns 0 for
    // a job that has been running for minutes. If a future edit reintroduces a
    // counter here, this is the assertion that fails.
    const eightyOneSeconds = elapsedSecs(NOW - 81_000, NOW);
    expect(eightyOneSeconds).not.toBe(0);
    expect(eightyOneSeconds).toBeGreaterThan(60);
  });

  it("returns null when the job never recorded a start", () => {
    // Old CLI rows on disk have startedAt: 0 — that is "unknown", not "now".
    expect(elapsedSecs(0, NOW)).toBeNull();
    expect(elapsedSecs(undefined, NOW)).toBeNull();
  });

  it("clamps a clock skew instead of rendering a negative age", () => {
    expect(elapsedSecs(NOW + 5_000, NOW)).toBe(0);
  });
});

describe("formatElapsed", () => {
  it("pads seconds so the width does not jitter each tick", () => {
    expect(formatElapsed(81)).toBe("1m21s");
    expect(formatElapsed(5)).toBe("0m05s");
    expect(formatElapsed(600)).toBe("10m00s");
    expect(formatElapsed(null)).toBeNull();
  });
});
