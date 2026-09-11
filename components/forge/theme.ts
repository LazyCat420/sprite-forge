/**
 * The forge panel's one look — dark, monospaced, quiet. Every card imports
 * from here so a colour decision happens once. Deliberately NOT the game's
 * palette: this is a workbench, not a screen the player sees.
 */
import type React from "react";

export const S = {
  /**
   * THE PANEL SCROLLS ITSELF. The game's reset.css locks
   * `html, body { height: 100%; overflow: hidden }` so the dungeon canvas
   * cannot be scrolled off — and /forge inherits that lock, which left
   * everything past the first screenful unreachable except by zooming out.
   * A fixed-height container with its own overflow-y restores scrolling
   * here without unlocking the body for the game.
   */
  page: {
    height: "100vh",
    overflowY: "auto",
    background: "#0a0a0f",
    color: "#c8ccd4",
    fontFamily: "ui-monospace, Consolas, monospace",
    fontSize: 13,
    padding: "24px 20px 80px",
  } as React.CSSProperties,
  wrap: { maxWidth: 1120, margin: "0 auto" } as React.CSSProperties,
  h1: { fontSize: 18, color: "#e8e6df", margin: "0 0 4px" } as React.CSSProperties,
  sub: { color: "#6a7080", margin: "0 0 16px" } as React.CSSProperties,
  // Longhand border properties EVERYWHERE a variant overrides the colour:
  // mixing the `border` shorthand with a `borderColor` override makes React
  // strip the property on rerender (its mixed-shorthand warning) — every
  // mode-button toggle used to fire a dev-overlay error and lose the border.
  card: {
    background: "#12141b",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "#23262f",
    borderRadius: 6,
    padding: "14px 16px",
    marginBottom: 16,
  } as React.CSSProperties,
  cardTitle: { fontSize: 14, color: "#e8e6df", margin: "0 0 10px" } as React.CSSProperties,
  btn: {
    background: "#1d2733",
    color: "#9fd0ff",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "#2c3a4a",
    borderRadius: 4,
    padding: "4px 10px",
    cursor: "pointer",
    fontFamily: "inherit",
    fontSize: 12,
  } as React.CSSProperties,
  btnGreen: { background: "#16281c", color: "#8fdd9f", borderColor: "#284832" } as React.CSSProperties,
  btnDanger: { background: "#281616", color: "#dd8f8f", borderColor: "#483028" } as React.CSSProperties,
  btnGhost: { background: "transparent", color: "#6a7080", borderColor: "#23262f" } as React.CSSProperties,
  input: {
    background: "#0d0f14",
    color: "#c8ccd4",
    // Longhand, for the reason given above `card` — and this one was the last
    // shorthand left. The job card's clip <select> tints its border amber
    // while no clip is chosen, and that override against a shorthand fired
    // exactly the warning the note describes, on every clip change.
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "#2c303b",
    borderRadius: 4,
    padding: "5px 8px",
    fontFamily: "inherit",
    fontSize: 12.5,
    width: "100%",
  } as React.CSSProperties,
  note: { color: "#6a7080", fontSize: 12, margin: "3px 0 0" } as React.CSSProperties,
  chip: (fg: string, bg: string): React.CSSProperties => ({
    display: "inline-block",
    color: fg,
    background: bg,
    borderRadius: 3,
    padding: "1px 7px",
    fontSize: 11,
    marginLeft: 8,
    verticalAlign: "1px",
  }),
  /** Checker background so transparent sprite pixels read as transparent. */
  checker: {
    backgroundImage:
      "linear-gradient(45deg,#1a1d26 25%,transparent 25%,transparent 75%,#1a1d26 75%),linear-gradient(45deg,#1a1d26 25%,transparent 25%,transparent 75%,#1a1d26 75%)",
    backgroundSize: "16px 16px",
    backgroundPosition: "0 0,8px 8px",
    backgroundColor: "#12141b",
  } as React.CSSProperties,
};

export const GREEN = { fg: "#8fdd9f", bg: "#16281c" };
export const RED = { fg: "#dd8f8f", bg: "#281616" };
export const BLUE = { fg: "#9fd0ff", bg: "#16202b" };
export const AMBER = { fg: "#ffd9a0", bg: "#2c2416" };
export const GREY = { fg: "#6a7080", bg: "#171921" };

export const fmtGB = (b: number) => (b / 1e9).toFixed(b >= 1e10 ? 0 : 1) + "GB";

export const fmtETA = (s: number) => (s >= 90 ? `~${Math.round(s / 60)}min` : `~${s}s`);
