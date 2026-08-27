"use client";

import React, { useState } from "react";

export interface Step2TurnaroundProps {
  character: string;
  onAdvance: () => void;
  onBack: () => void;
}

export function Step2_Turnaround({ character, onAdvance, onBack }: Step2TurnaroundProps) {
  const [isGenerating, setIsGenerating] = useState(false);
  const [facingsReady, setFacingsReady] = useState(true);

  const handleGenerateTurnaround = () => {
    setIsGenerating(true);
    setTimeout(() => {
      setIsGenerating(false);
      setFacingsReady(true);
    }, 1500);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div>
        <h2 style={{ fontSize: 20, fontWeight: 700, color: "#f0f6fc", margin: "0 0 6px" }}>
          Step 2: 3-Facing Turnaround Generation (S, E, N)
        </h2>
        <p style={{ fontSize: 13, color: "#8b949e", margin: 0 }}>
          Pinball Knight and 2.5D games require 3 core facings: South (Front), East (Side), and North (Back). Generate the turnaround angles and verify scale and ground line consistency.
        </p>
      </div>

      {/* 3 Facings Grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>
        {/* Facing S (Front) */}
        <div
          style={{
            background: "#161b22",
            border: "1px solid #30363d",
            borderRadius: 8,
            padding: 16,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 10,
          }}
        >
          <div style={{ fontWeight: 600, fontSize: 14, color: "#58a6ff" }}>
            South (S · Front Facing)
          </div>
          <div
            style={{
              width: 96,
              height: 144,
              background: "#0d1117",
              border: "1px solid #238636",
              borderRadius: 4,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              position: "relative",
            }}
          >
            <div style={{ width: 48, height: 80, background: "#3fb950", borderRadius: 2 }} />
            {/* Ground Line Guide */}
            <div
              style={{
                position: "absolute",
                bottom: 12,
                left: 0,
                right: 0,
                height: 1,
                background: "#44ff88",
              }}
            />
          </div>
          <span style={{ fontSize: 11, color: "#8fdd9f" }}>✓ Master Reference Locked</span>
        </div>

        {/* Facing E (Side Profile) */}
        <div
          style={{
            background: "#161b22",
            border: "1px solid #30363d",
            borderRadius: 8,
            padding: 16,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 10,
          }}
        >
          <div style={{ fontWeight: 600, fontSize: 14, color: "#58a6ff" }}>
            East (E · Side Profile)
          </div>
          <div
            style={{
              width: 96,
              height: 144,
              background: "#0d1117",
              border: "1px solid #238636",
              borderRadius: 4,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              position: "relative",
            }}
          >
            <div style={{ width: 38, height: 80, background: "#3fb950", borderRadius: 2 }} />
            {/* Ground Line Guide */}
            <div
              style={{
                position: "absolute",
                bottom: 12,
                left: 0,
                right: 0,
                height: 1,
                background: "#44ff88",
              }}
            />
          </div>
          <span style={{ fontSize: 11, color: "#8fdd9f" }}>✓ Aligned (y=44)</span>
        </div>

        {/* Facing N (Back Facing) */}
        <div
          style={{
            background: "#161b22",
            border: "1px solid #30363d",
            borderRadius: 8,
            padding: 16,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 10,
          }}
        >
          <div style={{ fontWeight: 600, fontSize: 14, color: "#58a6ff" }}>
            North (N · Back Facing)
          </div>
          <div
            style={{
              width: 96,
              height: 144,
              background: "#0d1117",
              border: "1px solid #238636",
              borderRadius: 4,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              position: "relative",
            }}
          >
            <div style={{ width: 46, height: 80, background: "#3fb950", borderRadius: 2 }} />
            {/* Ground Line Guide */}
            <div
              style={{
                position: "absolute",
                bottom: 12,
                left: 0,
                right: 0,
                height: 1,
                background: "#44ff88",
              }}
            />
          </div>
          <span style={{ fontSize: 11, color: "#8fdd9f" }}>✓ Aligned (y=44)</span>
        </div>
      </div>

      {/* Turnaround Generation Actions */}
      <div
        style={{
          background: "#161b22",
          border: "1px solid #30363d",
          borderRadius: 8,
          padding: 16,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div>
          <div style={{ fontWeight: 600, fontSize: 13, color: "#f0f6fc" }}>
            Turnaround Batch Generator
          </div>
          <div style={{ fontSize: 12, color: "#8b949e" }}>
            Renders missing E and N angles on DGX Spark and automatically computes silhouette drift.
          </div>
        </div>

        <button
          onClick={handleGenerateTurnaround}
          disabled={isGenerating}
          style={{
            background: "#238636",
            border: "1px solid #2ea043",
            color: "#fff",
            borderRadius: 6,
            padding: "8px 16px",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          {isGenerating ? "⚡ Generating Turnaround…" : "⚡ Re-Generate Missing Angles"}
        </button>
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
          ← Back to Concept Intake
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
          Proceed to Step 3: Moveset Matrix ➔
        </button>
      </div>
    </div>
  );
}
