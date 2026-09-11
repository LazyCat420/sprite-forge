/**
 * The progress bar must not report a model load as "0% sampling".
 *
 * The bug this pins shipped: `watchProgress` puts two different events on one
 * field, and only one of them is sampler progress.
 *
 *   sampler step   {node: "sh", value: 7,  max: 20}   -> 35%
 *   NODE CHANGE    {node: "uh", value: 0,  max: 1 }   -> not progress at all
 *
 * The second is emitted when execution moves to a new node — for a Wan job the
 * first one is always `uh`, the high-noise unet loader, and the load takes
 * ~90 seconds with no further traffic. Treating it as 0% pins the bar at zero
 * for a minute and a half, which is indistinguishable from a hung run. That is
 * the precise thing the live banner was built to rule out.
 *
 * The distinguishing test is `max > 1`, and the case that matters is the one a
 * looser check gets WRONG, so it is first.
 */
import { describe, expect, it } from "vitest";
import { samplerPct } from "./JobsBoard";

describe("samplerPct", () => {
  it("returns null for a node change, which a truthiness check reads as 0%", () => {
    // The exact payload observed on a live Wan run's first heartbeat.
    expect(samplerPct({ node: "uh", value: 0, max: 1 })).toBeNull();
  });

  it("returns a real percentage for a sampler step", () => {
    expect(samplerPct({ node: "sh", value: 7, max: 20 })).toBe(35);
  });

  it("distinguishes 0% sampling from no progress — both are falsy, only one is null", () => {
    // A genuine zeroth step of a 20-step sampler IS 0% and must render as a
    // bar, not as the indeterminate loader. If this and the node-change case
    // ever agree, the guard has stopped discriminating.
    expect(samplerPct({ node: "sh", value: 0, max: 20 })).toBe(0);
    expect(samplerPct({ node: "uh", value: 0, max: 1 })).toBeNull();
  });

  it("handles the ends of a run", () => {
    expect(samplerPct({ node: "sh", value: 20, max: 20 })).toBe(100);
    expect(samplerPct(undefined)).toBeNull();
  });
});
