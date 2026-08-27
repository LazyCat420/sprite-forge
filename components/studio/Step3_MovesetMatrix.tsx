"use client";

import React, { useState } from "react";

export interface Step3MovesetMatrixProps {
  character: string;
  turnaroundAngles?: { south: string; east: string; north: string } | null;
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
  { id: "idle", name: "Idle Stance", category: "Movement", frames: 6 },
  { id: "walk", name: "Walk Cycle", category: "Movement", frames: 8 },
  { id: "run", name: "Run Sprint", category: "Movement", frames: 8 },
  { id: "attack_slash", name: "Slash Attack", category: "Combat", frames: 6 },
  { id: "attack_thrust", name: "Thrust Attack", category: "Combat", frames: 6 },
  { id: "stumble", name: "Stumble / Hit", category: "Combat", frames: 4 },
  { id: "death", name: "Death Collapse", category: "State", frames: 8 },
  { id: "roll", name: "Roll / Dash", category: "State", frames: 6 },
];

export function Step3_MovesetMatrix({
  character,
  turnaroundAngles,
  onAdvance,
  onBack,
  onInspectClip,
}: Step3MovesetMatrixProps) {
  const [isBatchRunning, setIsBatchRunning] = useState(false);
  const [generatingClip, setGeneratingClip] = useState<string | null>(null);

  const handleGenerateClip = async (clipId: string, facing: "S" | "E" | "N") => {
    const key = `${clipId}_${facing}`;
    setGeneratingClip(key);

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "moveset",
          character,
          action: clipId,
          facing,
          frontDataUrl: turnaroundAngles?.south,
          eastDataUrl: turnaroundAngles?.east,
          northDataUrl: turnaroundAngles?.north,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Moveset generation failed");
      }

      onInspectClip(clipId, facing);
    } catch (err) {
      console.error(err);
    } finally {
      setGeneratingClip(null);
    }
  };

  const handleGenerateAll = () => {
    setIsBatchRunning(true);
    setTimeout(() => {
      setIsBatchRunning(false);
    }, 2500);
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
            Generate game animation clips conditioned on the 3 locked turnaround angles (<code style={{ color: "#58a6ff" }}>&lt;Picture 1..3&gt;</code>). Dispatched concurrently across Gold Spark and MSI Spark.
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

      {/* Multi-Reference Thumbnails Banner */}
      {turnaroundAngles && (
        <div
          style={{
            background: "#161b22",
            border: "1px solid #30363d",
            borderRadius: 8,
            padding: "12px 16px",
            display: "flex",
            alignItems: "center",
            gap: 20,
          }}
        >
          <span style={{ fontSize: 12, fontWeight: 600, color: "#8b949e" }}>
            Locked 3D Reference Set:
          </span>
          <div style={{ display: "flex", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 11, color: "#58a6ff" }}>&lt;Pic 1&gt; S:</span>
              <img
                src={turnaroundAngles.south}
                alt="South Reference"
                style={{ width: 28, height: 38, objectFit: "contain", imageRendering: "pixelated", borderRadius: 2, border: "1px solid #30363d" }}
              />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 11, color: "#58a6ff" }}>&lt;Pic 2&gt; E:</span>
              <img
                src={turnaroundAngles.east}
                alt="East Reference"
                style={{ width: 28, height: 38, objectFit: "contain", imageRendering: "pixelated", borderRadius: 2, border: "1px solid #30363d" }}
              />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 11, color: "#58a6ff" }}>&lt;Pic 3&gt; N:</span>
              <img
                src={turnaroundAngles.north}
                alt="North Reference"
                style={{ width: 28, height: 38, objectFit: "contain", imageRendering: "pixelated", borderRadius: 2, border: "1px solid #30363d" }}
              />
            </div>
          </div>
        </div>
      )}

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
                    onClick={() => handleGenerateClip(clip.id, "S")}
                    disabled={generatingClip === `${clip.id}_S`}
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
                    {generatingClip === `${clip.id}_S` ? "⚡ Rendering…" : `✓ Review (${clip.frames})`}
                  </button>
                </td>

                {/* E Facing Button */}
                <td style={{ padding: "12px 16px" }}>
                  <button
                    onClick={() => handleGenerateClip(clip.id, "E")}
                    disabled={generatingClip === `${clip.id}_E`}
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
                    {generatingClip === `${clip.id}_E` ? "⚡ Rendering…" : `✓ Review (${clip.frames})`}
                  </button>
                </td>

                {/* N Facing Button */}
                <td style={{ padding: "12px 16px" }}>
                  <button
                    onClick={() => handleGenerateClip(clip.id, "N")}
                    disabled={generatingClip === `${clip.id}_N`}
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
                    {generatingClip === `${clip.id}_N` ? "⚡ Rendering…" : `✓ Review (${clip.frames})`}
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
