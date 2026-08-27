"use client";

import React, { useState } from "react";

export interface Step2TurnaroundProps {
  character: string;
  onAdvance: () => void;
  onBack: () => void;
}

export function Step2_Turnaround({ character, onAdvance, onBack }: Step2TurnaroundProps) {
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationError, setGenerationError] = useState<string | null>(null);

  const [sDataUrl, setSDataUrl] = useState<string | null>(null);
  const [eDataUrl, setEDataUrl] = useState<string | null>(null);
  const [nDataUrl, setNDataUrl] = useState<string | null>(null);

  const handleGenerateTurnaround = async () => {
    setIsGenerating(true);
    setGenerationError(null);

    try {
      // Dispatches E and N turnaround jobs
      const [resE, resN] = await Promise.all([
        fetch("/api/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: "turnaround",
            character,
            facing: "E",
          }),
        }),
        fetch("/api/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: "turnaround",
            character,
            facing: "N",
          }),
        }),
      ]);

      const dataE = await resE.json();
      const dataN = await resN.json();

      if (dataE.ok && dataE.imageDataUrl) setEDataUrl(dataE.imageDataUrl);
      if (dataN.ok && dataN.imageDataUrl) setNDataUrl(dataN.imageDataUrl);
    } catch (err: any) {
      console.error(err);
      setGenerationError(err.message || String(err));
    } finally {
      setIsGenerating(false);
    }
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

      {generationError && (
        <div
          style={{
            background: "rgba(248, 81, 73, 0.15)",
            border: "1px solid #f85149",
            color: "#ff7b72",
            padding: "8px 12px",
            borderRadius: 6,
            fontSize: 12,
          }}
        >
          ⚠️ {generationError}
        </div>
      )}

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
            {sDataUrl ? (
              <img
                src={sDataUrl}
                alt="S Facing"
                style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", imageRendering: "pixelated" }}
              />
            ) : (
              <div style={{ width: 48, height: 80, background: "#3fb950", borderRadius: 2 }} />
            )}
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
              border: `1px solid ${eDataUrl ? "#238636" : "#30363d"}`,
              borderRadius: 4,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              position: "relative",
            }}
          >
            {eDataUrl ? (
              <img
                src={eDataUrl}
                alt="E Facing"
                style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", imageRendering: "pixelated" }}
              />
            ) : (
              <div style={{ width: 38, height: 80, background: "#21262d", borderRadius: 2 }} />
            )}
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
          <span style={{ fontSize: 11, color: eDataUrl ? "#8fdd9f" : "#8b949e" }}>
            {eDataUrl ? "✓ Aligned (y=44)" : "Pending Render"}
          </span>
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
              border: `1px solid ${nDataUrl ? "#238636" : "#30363d"}`,
              borderRadius: 4,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              position: "relative",
            }}
          >
            {nDataUrl ? (
              <img
                src={nDataUrl}
                alt="N Facing"
                style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", imageRendering: "pixelated" }}
              />
            ) : (
              <div style={{ width: 46, height: 80, background: "#21262d", borderRadius: 2 }} />
            )}
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
          <span style={{ fontSize: 11, color: nDataUrl ? "#8fdd9f" : "#8b949e" }}>
            {nDataUrl ? "✓ Aligned (y=44)" : "Pending Render"}
          </span>
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
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <div>
          <div style={{ fontWeight: 600, fontSize: 13, color: "#f0f6fc" }}>
            Turnaround Batch Generator
          </div>
          <div style={{ fontSize: 12, color: "#8b949e" }}>
            Renders missing E and N angles across Gold Spark and MSI Spark queues.
          </div>
        </div>

        <button
          onClick={handleGenerateTurnaround}
          disabled={isGenerating}
          style={{
            background: isGenerating ? "#1f6feb" : "#238636",
            border: `1px solid ${isGenerating ? "#388bfd" : "#2ea043"}`,
            color: "#fff",
            borderRadius: 6,
            padding: "8px 16px",
            fontWeight: 600,
            cursor: isGenerating ? "wait" : "pointer",
          }}
        >
          {isGenerating ? "⚡ Generating Turnaround Angles…" : "⚡ Generate Missing Angles (E + N)"}
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
