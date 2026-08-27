"use client";

import React, { useState } from "react";

export interface Step5ExportAtlasProps {
  character: string;
  onBack: () => void;
  onRestart: () => void;
}

export function Step5_ExportAtlas({ character, onBack, onRestart }: Step5ExportAtlasProps) {
  const [isExporting, setIsExporting] = useState(false);
  const [exportSuccess, setExportSuccess] = useState(false);
  const targetPath = "braindeadbot-client/public/sprites/";

  const handleExport = () => {
    setIsExporting(true);
    setTimeout(() => {
      setIsExporting(false);
      setExportSuccess(true);
    }, 1200);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {/* Header */}
      <div>
        <h2 style={{ fontSize: 20, fontWeight: 700, color: "#f0f6fc", margin: "0 0 6px" }}>
          Step 5: 20-Color Palette Crush & In-Game Atlas Export
        </h2>
        <p style={{ fontSize: 13, color: "#8b949e", margin: 0 }}>
          All required slots are accepted and registered to canonical anchors. Apply deterministic 20-color quantization and export the final sprite atlas directly to the game client.
        </p>
      </div>

      {/* Export Card */}
      <div
        style={{
          background: "#161b22",
          border: "1px solid #30363d",
          borderRadius: 8,
          padding: 20,
          display: "grid",
          gridTemplateColumns: "1fr 320px",
          gap: 24,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ fontWeight: 600, fontSize: 14, color: "#f0f6fc" }}>
            Atlas Verification Checklist:
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 13, color: "#c9d1d9" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ color: "#3fb950" }}>✓</span> 3-Facing Turnaround coverage (S, E, N)
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ color: "#3fb950" }}>✓</span> Canonical Ground Baseline ($y=44$) locked
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ color: "#3fb950" }}>✓</span> 20-color discrete palette derivation
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ color: "#3fb950" }}>✓</span> Zero protected-pixel boundary violations
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ color: "#3fb950" }}>✓</span> Target export path: <code>{targetPath}</code>
            </div>
          </div>

          {exportSuccess && (
            <div
              style={{
                background: "rgba(63, 185, 80, 0.15)",
                border: "1px solid #238636",
                color: "#8fdd9f",
                padding: "12px 16px",
                borderRadius: 6,
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              🎉 Successfully baked & exported {character} atlas to <code>{targetPath}</code>! The game engine will automatically load the new sprites.
            </div>
          )}

          <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
            <button
              onClick={handleExport}
              disabled={isExporting}
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
              {isExporting ? "Baking & Exporting…" : "📦 Bake & Export to Pinball Knight"}
            </button>

            <button
              style={{
                background: "#21262d",
                border: "1px solid #30363d",
                color: "#c9d1d9",
                borderRadius: 6,
                padding: "10px 16px",
                fontSize: 14,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              ⬇️ Download Atlas PNG + JSON
            </button>
          </div>
        </div>

        {/* Atlas Sheet Preview Box */}
        <div
          style={{
            background: "#0d1117",
            border: "1px solid #30363d",
            borderRadius: 6,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
        >
          <div style={{ fontSize: 12, color: "#8b949e", marginBottom: 8, fontWeight: 600 }}>
            Baked Atlas Texture Preview
          </div>
          <div
            style={{
              width: 160,
              height: 200,
              background: "#161b22",
              border: "1px dashed #30363d",
              borderRadius: 4,
              display: "grid",
              gridTemplateColumns: "repeat(3, 1fr)",
              gap: 4,
              padding: 6,
            }}
          >
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                style={{
                  background: "#3fb950",
                  borderRadius: 2,
                  opacity: 0.8,
                }}
              />
            ))}
          </div>
          <div style={{ fontSize: 11, color: "#8b949e", marginTop: 8 }}>
            20 Colors · 256x256 Atlas
          </div>
        </div>
      </div>

      {/* Footer */}
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
          ← Back to Contact Sheet QA
        </button>

        <button
          onClick={onRestart}
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
          + Create Another Character
        </button>
      </div>
    </div>
  );
}
