"use client";

/**
 * Scrub a returned motion clip and pick the frames worth keeping.
 *
 * A Wan run returns 17-33 frames of 16fps motion; a sprite clip wants 3-8
 * with big readable pose deltas. So the player exists to LOOK, and the
 * stride + checkboxes exist to CHOOSE — the selection flows into the sheet
 * tray, everything else stays on disk.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { S, BLUE, RED, AMBER } from "./theme";
import { RetryImg } from "./RetryImg";

/** Per-frame ghost verdict as the generate route records it. See `ghost.ts`. */
export type GhostInfo = { pct: number[]; flagged: number[]; soft: number[] };

export function FramePlayer({
  frames,
  onAdd,
  ghost,
}: {
  frames: { name: string; src: string }[];
  onAdd: (srcs: string[]) => void;
  ghost?: GhostInfo;
}) {
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [stride, setStride] = useState(1);
  const [sel, setSel] = useState<Set<number>>(new Set());
  /**
   * SKIPPING THE GHOSTS IS THE DEFAULT, and it is the whole point of the gate.
   *
   * The manual version of this — scrub the strip, notice the smeared frames,
   * click the others — is what a human did to this clip by hand and it is what
   * made the walk read as a walk. Doing it by default means the FIRST thing
   * played is the clip that would actually ship, instead of a clip with three
   * morphs in it that has to be mentally corrected for.
   *
   * It is a toggle rather than a filter because the flagged frames are still
   * evidence: turning it off is how you check the gate is not eating good art.
   */
  const [skipGhosts, setSkipGhosts] = useState(true);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const flagged = useMemo(() => new Set(ghost?.flagged ?? []), [ghost]);
  const softSet = useMemo(() => new Set(ghost?.soft ?? []), [ghost]);
  const hidden = (i: number) => skipGhosts && flagged.has(i);
  /** The frames the clip is made of once the ghosts are out. */
  const playable = useMemo(
    () => frames.map((_, i) => i).filter((i) => !(skipGhosts && flagged.has(i))),
    [frames, skipGhosts, flagged],
  );

  useEffect(() => {
    if (playing) {
      timer.current = setInterval(() => {
        // Advance along the PLAYABLE ring, not the raw index, so a skipped
        // ghost never flashes for one frame on its way past.
        setIdx((i) => {
          if (!playable.length) return i;
          const at = playable.indexOf(i);
          return playable[(at < 0 ? 0 : at + 1) % playable.length];
        });
      }, 1000 / 12);
    } else if (timer.current) {
      clearInterval(timer.current);
    }
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [playing, playable]);

  const strided = playable.filter((_, n) => n % stride === 0);

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={frames[idx] ? `${frames[idx].src}&w=384` : undefined}
            alt={`frame ${idx}`}
            style={{ width: 192, height: 192, objectFit: "contain", background: "#fff", borderRadius: 4 }}
          />
          <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 6 }}>
            <button style={S.btn} onClick={() => setPlaying(!playing)}>
              {playing ? "pause" : "play"}
            </button>
            <input
              type="range"
              min={0}
              max={frames.length - 1}
              value={idx}
              style={{ flex: 1 }}
              onChange={(e) => {
                setPlaying(false);
                setIdx(+e.target.value);
              }}
            />
            <span style={S.note}>
              {idx + 1}/{frames.length}
              {skipGhosts && flagged.size > 0 ? ` · playing ${playable.length}` : ""}
            </span>
          </div>
        </div>
        <div style={{ flex: 1, minWidth: 320 }}>
          {ghost && (flagged.size > 0 || softSet.size > 0) && (
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6, flexWrap: "wrap" }}>
              <span style={S.chip(RED.fg, RED.bg)}>
                {flagged.size} dissolved {flagged.size === 1 ? "frame" : "frames"}
              </span>
              {softSet.size > 0 && <span style={S.chip(AMBER.fg, AMBER.bg)}>{softSet.size} borderline</span>}
              <button
                style={{ ...S.btn, ...(skipGhosts ? S.btnGreen : {}) }}
                title="a dissolved frame renders a limb see-through; played back it reads as morphing, not walking"
                onClick={() => setSkipGhosts(!skipGhosts)}
              >
                {skipGhosts ? "✓ skipping them" : "including them"}
              </button>
            </div>
          )}
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
            <span style={S.note}>keep every</span>
            {[1, 2, 3, 4].map((n) => (
              <button key={n} style={{ ...S.btn, ...(stride === n ? S.btnGreen : {}) }} onClick={() => setStride(n)}>
                {n === 1 ? "all" : `${n}th`}
              </button>
            ))}
            <button
              style={S.btn}
              onClick={() => setSel(new Set(strided))}
              title="select the strided frames below"
            >
              select these
            </button>
            {sel.size > 0 && (
              <button
                style={{ ...S.btn, ...S.btnGreen }}
                onClick={() => {
                  onAdd([...sel].sort((a, b) => a - b).map((i) => frames[i].src));
                  setSel(new Set());
                }}
              >
                add {sel.size} to sheet →
              </button>
            )}
          </div>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {frames.map((f, i) => {
              const bad = flagged.has(i);
              const meh = softSet.has(i);
              const dim = hidden(i) || (stride > 1 && !strided.includes(i));
              const on = sel.has(i);
              const score = ghost?.pct?.[i];
              const ring = on ? BLUE.fg : bad ? RED.fg : meh ? AMBER.fg : "transparent";
              return (
                <button
                  key={f.name}
                  onClick={() => {
                    const next = new Set(sel);
                    if (on) next.delete(i);
                    else next.add(i);
                    setSel(next);
                    setPlaying(false);
                    setIdx(i);
                  }}
                  title={
                    score === undefined
                      ? f.name
                      : `${f.name} — ghost ${score.toFixed(2)}%${bad ? " (dissolved limb)" : meh ? " (borderline)" : ""}`
                  }
                  style={{
                    padding: 0,
                    border: `2px solid ${ring}`,
                    borderRadius: 4,
                    background: "none",
                    cursor: "pointer",
                    opacity: dim ? 0.35 : 1,
                    position: "relative",
                  }}
                >
                  <RetryImg src={`${f.src}&w=112`} alt={f.name} style={{ width: 56, height: 56, objectFit: "contain", background: "#fff", borderRadius: 2, display: "block" }} />
                  {bad && (
                    <span
                      style={{
                        position: "absolute", top: 1, right: 2, fontSize: 11, lineHeight: 1,
                        color: RED.fg, textShadow: "0 0 3px #000",
                      }}
                    >
                      ✗
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
