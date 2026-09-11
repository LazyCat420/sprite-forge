"use client";

/**
 * THE SWEEP BANNER — "is the pipeline working?", answered without Task Manager.
 *
 * ── WHY A SECOND BANNER ─────────────────────────────────────────────────────
 *
 * The jobs board already grew a per-job banner (running label, elapsed,
 * sampling %). It was verified working and the operator still could not tell
 * the machine was busy, which is not a contradiction — it is the per-job view
 * answering a different question from the one being asked.
 *
 * `bench-moveset.mjs` runs 21 generations back to back and calls ComfyUI's
 * /free between every one, reloading ~31GB of weights each time. For 30-90
 * seconds per row there is genuinely NO job: the queue is empty, the board is
 * empty, and everything is fine. Across a full sweep that is twenty windows in
 * which a working pipeline is indistinguishable from a dead one.
 *
 * So this reads the sweep's own published state and stays up THROUGH the gaps.
 * It is the difference between "a job is running" and "the pipeline is working".
 *
 * ── IT MUST ALSO SHOW A SWEEP THAT DIED ─────────────────────────────────────
 *
 * A progress bar that only ever means good news is the failure this repo keeps
 * writing down. `_sweep.json` stops being updated when the process is killed,
 * so staleness is the signal: no update for STALE_MS and no `finishedAt` means
 * the sweep died, and that renders red rather than simply vanishing. A banner
 * that disappears on a crash looks identical to one that finished.
 */
import React from "react";
import type { SweepState } from "./types";

/**
 * A row takes 6-15 minutes and the bench publishes on transitions, not on a
 * timer — so the longest legitimate silence is one whole generation plus the
 * free/reload around it. 20 minutes is comfortably past that and still catches
 * a dead sweep within one row's worth of time.
 */
const STALE_MS = 20 * 60 * 1000;

const mmss = (s: number) => `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, "0")}s`;
const hhmm = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.round((s % 3600) / 60)).padStart(2, "0")}m` : mmss(s));

export function SweepBanner({ sweep, now }: { sweep: SweepState | null; now: number }) {
  if (!sweep) return null;

  const stale = !sweep.finishedAt && now - sweep.updatedAt > STALE_MS;
  const finished = Boolean(sweep.finishedAt) && !sweep.stopped;
  const stopped = Boolean(sweep.stopped);
  const pct = sweep.total > 0 ? Math.min(100, Math.round((sweep.completed / sweep.total) * 100)) : 0;

  // A finished sweep is worth seeing for a while, but not forever — it becomes
  // noise on a page whose whole job is showing what is happening NOW.
  if (finished && now - (sweep.finishedAt ?? 0) > 30 * 60 * 1000) return null;

  const tone = stale
    ? { bg: "#2a1214", border: "#5c1d22", fg: "#ff9d9d", head: "#ffd0d0" }
    : stopped
      ? { bg: "#2a2412", border: "#5c4f1d", fg: "#f0c674", head: "#ffe6b0" }
      : finished
        ? { bg: "#13251a", border: "#215c33", fg: "#8fe0a8", head: "#d0ffe0" }
        : { bg: "#0d1b2e", border: "#1d3a5c", fg: "#8fc2ff", head: "#cfe6ff" };

  const status = stale
    ? `NO UPDATE FOR ${hhmm((now - sweep.updatedAt) / 1000)} — the sweep died`
    : stopped
      ? "stopped"
      : finished
        ? "complete"
        : sweep.current
          ? `${sweep.current}${sweep.currentPreset ? ` · ${sweep.currentPreset}` : ""}`
          : (sweep.phase ?? "between rows");

  return (
    <div style={{ margin: "0 0 12px", padding: "10px 12px", borderRadius: 6, background: tone.bg, border: `1px solid ${tone.border}` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: tone.fg, fontFamily: "monospace", flexWrap: "wrap" }}>
        {!finished && !stale && !stopped && (
          <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 8, background: "#4da3ff", animation: "sweepPulse 1.1s ease-in-out infinite" }} />
        )}
        <strong style={{ color: tone.head }}>sweep · {sweep.character}</strong>
        <span>{sweep.completed}/{sweep.total} rows</span>
        <span>· {status}</span>
        {/* Between rows the machine is loading 31GB, which looks like nothing
            is happening. Saying so is the entire point of this banner. */}
        {!finished && !stale && !stopped && !sweep.current && (
          <span style={{ opacity: 0.75 }}>· loading models (~31GB, this is normal)</span>
        )}
        {!finished && !stale && sweep.etaS ? <span style={{ opacity: 0.75 }}>· ~{hhmm(sweep.etaS)} left</span> : null}
      </div>
      <div style={{ marginTop: 6, height: 5, borderRadius: 4, background: "#12233a", overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${pct}%`, background: stale ? "#c04a4a" : stopped ? "#c9a227" : finished ? "#3fa05f" : "#4da3ff", transition: "width .5s linear" }} />
      </div>
      {stale && (
        <p style={{ margin: "6px 0 0", fontSize: 11, color: tone.fg, fontFamily: "monospace" }}>
          last row {sweep.current ?? "unknown"} · check <code>~/comfy/guard.log</code> first, it names the cause in one line
        </p>
      )}
      <style>{"@keyframes sweepPulse{0%,100%{opacity:1}50%{opacity:.25}}"}</style>
    </div>
  );
}
