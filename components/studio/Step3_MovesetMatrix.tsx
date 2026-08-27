"use client";

import React, { useState } from "react";

export interface Step3MovesetMatrixProps {
  character: string;
  onAdvance: () => void;
  onBack: () => void;
  onInspectClip: (clip: string, facing: "S" | "E" | "N") => void;
}

interface ClipSpec {
  id: string;
  name: string;
  category: "Movement" | "Combat" | "State";
  frames: number;
}

const CLIPS: ClipSpec[] = [
  { id: "idle", name: "Idle", category: "Movement", frames: 6 },
  { id: "walk", name: "Walk", category: "Movement", frames: 8 },
  { id: "run", name: "Run", category: "Movement", frames: 8 },
  { id: "attack_slash", name: "Slash Attack", category: "Combat", frames: 6 },
  { id: "attack_thrust", name: "Thrust Attack", category: "Combat", frames: 6 },
  { id: "stumble", name: "Stumble / Hit", category: "Combat", frames: 4 },
  { id: "death", name: "Death", category: "State", frames: 8 },
  { id: "roll", name: "Roll / Dash", category: "State", frames: 6 },
];

export function Step3_MovesetMatrix({
  character,
  onAdvance,
  onBack,
  onInspectClip,
}: Step3MovesetMatrixProps) {
  const [isBatchRunning, setIsBatchRunning] = useState(false);

  const handleGenerateAll = () => {
    setIsBatchRunning(true);
    setTimeout(() => {
      setIsBatchRunning(false);
    }, 2000);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {/* Header & Batch Controls */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h2 style={{ fontSize: 20, fontWeight: 700, color: "#f0f6fc", margin: "0 0 6px" }}>
            Step 3: Action Moveset Matrix ({character})
          </h2>
          <p style={{ fontSize: 13, color: "#8b949e", margin: 0 }}>
            Generate the game action clips across all 3 facings (S, E, N). Jobs are dispatched concurrently across Gold Spark (Queue 1) and MSI Spark (Queue 2).
          </p>
        </div>

        <button
          onClick={handleGenerateAll}
          disabled={isBatchRunning}
          style={{
            background: "#238636",
            border: "1px solid #2ea043",
            color: "#fff",
            borderRadius: 6,
            padding: "10px 20px",
            fontSize: 14,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          {isBatchRunning ? "⚡ Batch Generating on DGX Spark…" : "⚡ Generate Full Moveset (18 Clips)"}
        </button>
      </div>

      {/* Moveset Grid */}
      <div
        style={{
          background: "#161b22",
          border: "1px solid #30363d",
          borderRadius: 8,
          overflow: "hidden",
        }}
      >
        <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left" }}>
          <thead>
            <tr style={{ background: "#0d1117", borderBottom: "1px solid #30363d" }}>
              <th style={{ padding: "12px 16px", fontSize: 13, color: "#8b949e" }}>Action Clip</th>
              <th style={{ padding: "12px 16px", fontSize: 13, color: "#8b949e" }}>Category</th>
              <th style={{ padding: "12px 16px", fontSize: 13, color: "#8b949e" }}>Frames</th>
              <th style={{ padding: "12px 16px", fontSize: 13, color: "#58a6ff" }}>South (S · Front)</th>
              <th style={{ padding: "12px 16px", fontSize: 13, color: "#58a6ff" }}>East (E · Side)</th>
              <th style={{ padding: "12px 16px", fontSize: 13, color: "#58a6ff" }}>North (N · Back)</th>
            </tr>
          </thead>
          <tbody>
            {CLIPS.map((clip, idx) => (
              <tr
                key={clip.id}
                style={{
                  borderBottom: idx < CLIPS.length - 1 ? "1px solid #21262d" : "none",
                  background: idx % 2 === 0 ? "transparent" : "rgba(255,255,255,0.01)",
                }}
              >
                <td style={{ padding: "12px 16px", fontWeight: 600, fontSize: 13, color: "#f0f6fc" }}>
                  {clip.name}
                </td>
                <td style={{ padding: "12px 16px", fontSize: 12, color: "#8b949e" }}>
                  {clip.category}
                </td>
                <td style={{ padding: "12px 16px", fontSize: 12, color: "#8b949e" }}>
                  {clip.frames} cels
                </td>

                {/* S Facing Button */}
                <td style={{ padding: "12px 16px" }}>
                  <button
                    onClick={() => onInspectClip(clip.id, "S")}
                    style={{
                      background: "#21262d",
                      border: "1px solid #30363d",
                      borderRadius: 4,
                      color: "#8fdd9f",
                      padding: "4px 10px",
                      fontSize: 11,
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    ✓ Review ({clip.frames})
                  </button>
                </td>

                {/* E Facing Button */}
                <td style={{ padding: "12px 16px" }}>
                  <button
                    onClick={() => onInspectClip(clip.id, "E")}
                    style={{
                      background: "#21262d",
                      border: "1px solid #30363d",
                      borderRadius: 4,
                      color: "#8fdd9f",
                      padding: "4px 10px",
                      fontSize: 11,
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    ✓ Review ({clip.frames})
                  </button>
                </td>

                {/* N Facing Button */}
                <td style={{ padding: "12px 16px" }}>
                  <button
                    onClick={() => onInspectClip(clip.id, "N")}
                    style={{
                      background: "#21262d",
                      border: "1px solid #30363d",
                      borderRadius: 4,
                      color: "#8fdd9f",
                      padding: "4px 10px",
                      fontSize: 11,
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    ✓ Review ({clip.frames})
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Navigation Footer */}
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <button
          onClick={onBack}
          style={{
            background: "#21262d",
            border: "1px solid #30363d",
            color: "#c9d1d9",
            borderRadius: 6,
            padding: "10px 20px",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          ← Back to 3-Way Turnaround
        </button>

        <button
          onClick={onAdvance}
          style={{
            background: "#1f6feb",
            border: "1px solid #388bfd",
            color: "#fff",
            borderRadius: 6,
            padding: "10px 24px",
            fontSize: 14,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Proceed to Step 4: Contact Sheet QA ➔
        </button>
      </div>
    </div>
  );
}
