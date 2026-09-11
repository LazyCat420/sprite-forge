/**
 * Scalar maths helpers.
 *
 * These exist because `Math.max(lo, Math.min(hi, v))` was written out inline at
 * roughly twenty call sites. Spelled out, the argument order is easy to invert
 * (`Math.min(lo, Math.max(hi, v))` reads almost the same and is always wrong),
 * and the intent — "keep this in range" — is buried in the arithmetic.
 */

/** Constrain `value` to the inclusive range [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Constrain `value` to [0, 1] — the common case for ratios, alphas and mix factors. */
export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

/**
 * Linear interpolation from `a` to `b` at position `t`.
 * `t` is NOT clamped: overshoot is sometimes wanted (springs, easing past a target).
 */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Inverse of lerp — where `value` sits between `a` and `b`, as a 0..1 ratio.
 * Returns 0 for a degenerate range rather than dividing by zero.
 */
export function invLerp(a: number, b: number, value: number): number {
  if (a === b) return 0;
  return (value - a) / (b - a);
}
