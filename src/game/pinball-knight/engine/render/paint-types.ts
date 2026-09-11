/**
 * The vocabulary of the painter-based sprite pipeline.
 */

export type FramePaint = (ctx: CanvasRenderingContext2D) => void;

export type Dir = "S" | "N" | "E";

export type ClipName =
  | "idle"
  | "walk"
  | "run"
  | "attack"
  | "death"
  | "roll"
  | "pain"
  | "tumble"
  | "stumble"
  | "crouch"
  | "wait"
  | "wake"
  | "ball"
  | "special"
  | "remove";
