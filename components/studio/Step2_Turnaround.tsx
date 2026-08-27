"use client";

import React, { useState } from "react";

export interface Step2TurnaroundProps {
  character: string;
  masterRefDataUrl: string | null;
  onAdvance: () => void;
  onBack: () => void;
  onSetTurnaroundAngles?: (angles: { south: string; east: string; north: string }) => void;
}

export function Step2_Turnaround({
  character,
  masterRefDataUrl,
  onAdvance,
  onBack,
  onSetTurnaroundAngles,
}: Step2TurnaroundProps) {
  const [isGenerating, setIsGenerating] = useState(false);
  const [isGeneratingE, setIsGeneratingE] = useState(false);
  const [isGeneratingN, setIsGeneratingN] = useState(false);
  const [generationError, setGenerationError] = useState<string | null>(null);

  const [engine, setEngine] = useState<"sv3d" | "zero123">("sv3d");
  const [cameraOffset, setCameraOffset] = useState<number>(0);
  const [eDataUrl, setEDataUrl] = useState<string | null>(null);
  const [nDataUrl, setNDataUrl] = useState<string | null>(null);
  const [sheetDataUrl, setSheetDataUrl] = useState<string | null>(null);

  // Single-pass 3D Multi-View Orbit Generator (SV3D / Zero123++)
  const handleGenerateMultiView = async () => {
    if (!masterRefDataUrl) return;
    setIsGenerating(true);
    setGenerationError(null);

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "multiview_turnaround",
          engine,
          character,
          initImageDataUrl: masterRefDataUrl,
          cameraOffset,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Multi-View generation failed on DGX Spark");
      }

      if (data.eastUrl) setEDataUrl(data.eastUrl);
      if (data.northUrl) setNDataUrl(data.northUrl);
      if (data.sheetUrl) setSheetDataUrl(data.sheetUrl);

      onSetTurnaroundAngles?.({
        south: data.frontUrl || masterRefDataUrl,
        east: data.eastUrl || data.imageDataUrl,
        north: data.northUrl || data.imageDataUrl,
      });
    } catch (err: any) {
      console.error(err);
      setGenerationError(err.message || String(err));
    } finally {
      setIsGenerating(false);
    }
  };

  // Per-Angle fallback generation
  const handleGenerateSingleAngle = async (facing: "E" | "N") => {
    if (!masterRefDataUrl) return;
    setGenerationError(null);
    if (facing === "E") setIsGeneratingE(true);
    if (facing === "N") setIsGeneratingN(true);

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "turnaround",
          character,
          facing,
          initImageDataUrl: masterRefDataUrl,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(`${facing}-Facing: ${data.error || "Generation failed"}`);
      }

      if (data.imageDataUrl) {
        if (facing === "E") {
          setEDataUrl(data.imageDataUrl);
          onSetTurnaroundAngles?.({
            south: masterRefDataUrl,
            east: data.imageDataUrl,
            north: nDataUrl || masterRefDataUrl,
          });
        }
        if (facing === "N") {
          setNDataUrl(data.imageDataUrl);
          onSetTurnaroundAngles?.({
            south: masterRefDataUrl,
            east: eDataUrl || masterRefDataUrl,
            north: data.imageDataUrl,
          });
        }
      }
    } catch (err: any) {
      console.error(err);
      setGenerationError(err.message || String(err));
    } finally {
      if (facing === "E") setIsGeneratingE(false);
      if (facing === "N") setIsGeneratingN(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div>
        <h2 style={{ fontSize: 20, fontWeight: 700, color: "#f0f6fc", margin: "0 0 6px" }}>
          Step 2: 3-Facing Turnaround Generation (S, E, N)
        </h2>
        <p style={{ fontSize: 13, color: "#8b949e", margin: 0 }}>
          Generates canonical East (90° Side Profile) and North (180° Back Facing) views with locked 3D geometry, proportion consistency, and ground baseline (y=44).
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
              width: 110,
              height: 160,
              background: "#0d1117",
              border: "1px solid #238636",
              borderRadius: 4,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              position: "relative",
              overflow: "hidden",
            }}
          >
            {masterRefDataUrl ? (
              <img
                src={masterRefDataUrl}
                alt="S Facing Master Reference"
                style={{ width: "100%", height: "100%", objectFit: "contain", imageRendering: "pixelated" }}
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
          <span style={{ fontSize: 11, color: "#8fdd9f" }}>✓ Step 1 Master Reference Locked</span>
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
              width: 110,
              height: 160,
              background: "#0d1117",
              border: `1px solid ${eDataUrl ? "#238636" : "#30363d"}`,
              borderRadius: 4,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              position: "relative",
              overflow: "hidden",
            }}
          >
            {isGeneratingE ? (
              <div style={{ fontSize: 12, color: "#58a6ff", textAlign: "center" }}>
                ⚡ Rendering on Gold Spark…
              </div>
            ) : eDataUrl ? (
              <img
                src={eDataUrl}
                alt="E Facing"
                style={{ width: "100%", height: "100%", objectFit: "contain", imageRendering: "pixelated" }}
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
          <button
            onClick={() => handleGenerateSingleAngle("E")}
            disabled={isGeneratingE || !masterRefDataUrl}
            style={{
              fontSize: 11,
              background: "#21262d",
              border: "1px solid #30363d",
              color: "#c9d1d9",
              borderRadius: 4,
              padding: "4px 8px",
              cursor: "pointer",
            }}
          >
            {isGeneratingE ? "Rendering…" : eDataUrl ? "↺ Re-render East" : "⚡ Render East"}
          </button>
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
              width: 110,
              height: 160,
              background: "#0d1117",
              border: `1px solid ${nDataUrl ? "#238636" : "#30363d"}`,
              borderRadius: 4,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              position: "relative",
              overflow: "hidden",
            }}
          >
            {isGeneratingN ? (
              <div style={{ fontSize: 12, color: "#58a6ff", textAlign: "center" }}>
                ⚡ Rendering on MSI Spark…
              </div>
            ) : nDataUrl ? (
              <img
                src={nDataUrl}
                alt="N Facing"
                style={{ width: "100%", height: "100%", objectFit: "contain", imageRendering: "pixelated" }}
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
          <button
            onClick={() => handleGenerateSingleAngle("N")}
            disabled={isGeneratingN || !masterRefDataUrl}
            style={{
              fontSize: 11,
              background: "#21262d",
              border: "1px solid #30363d",
              color: "#c9d1d9",
              borderRadius: 4,
              padding: "4px 8px",
              cursor: "pointer",
            }}
          >
            {isGeneratingN ? "Rendering…" : nDataUrl ? "↺ Re-render North" : "⚡ Render North"}
          </button>
        </div>
      </div>

      {/* 3D Multi-View Turnaround Action Banner */}
      <div
        style={{
          background: "#161b22",
          border: "1px solid #30363d",
          borderRadius: 8,
          padding: 18,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 14,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 14, color: "#f0f6fc" }}>
              3D Consistency Multi-View Generator
            </div>
            <div style={{ fontSize: 12, color: "#8b949e", marginTop: 2 }}>
              Extracts Front (0°), Profile (90°), and Back (180°) in a single orbital pass.
            </div>
          </div>

          {/* Engine Selector Toggle */}
          <div style={{ display: "flex", gap: 6, background: "#0d1117", padding: 4, borderRadius: 6, border: "1px solid #30363d" }}>
            <button
              onClick={() => setEngine("sv3d")}
              style={{
                background: engine === "sv3d" ? "#1f6feb" : "transparent",
                color: engine === "sv3d" ? "#fff" : "#8b949e",
                border: "none",
                borderRadius: 4,
                padding: "4px 10px",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              SV3D Orbit (360°)
            </button>
            <button
              onClick={() => setEngine("zero123")}
              style={{
                background: engine === "zero123" ? "#1f6feb" : "transparent",
                color: engine === "zero123" ? "#fff" : "#8b949e",
                border: "none",
                borderRadius: 4,
                padding: "4px 10px",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Zero123++ (6-View)
            </button>
          </div>

          {/* Camera Extraction Angle Slider */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, background: "#0d1117", padding: "6px 12px", borderRadius: 6, border: "1px solid #30363d" }}>
            <span style={{ fontSize: 12, color: "#8b949e" }}>Camera Nudge:</span>
            <input
              type="range"
              min="-15"
              max="15"
              step="1"
              value={cameraOffset}
              onChange={(e) => setCameraOffset(Number(e.target.value))}
              style={{ width: 80, cursor: "pointer" }}
            />
            <span style={{ fontSize: 11, color: "#58a6ff", minWidth: 28 }}>{cameraOffset > 0 ? `+${cameraOffset}°` : `${cameraOffset}°`}</span>
          </div>
        </div>

        <button
          onClick={handleGenerateMultiView}
          disabled={isGenerating || !masterRefDataUrl}
          style={{
            background: isGenerating ? "#1f6feb" : "#238636",
            border: `1px solid ${isGenerating ? "#388bfd" : "#2ea043"}`,
            color: "#fff",
            borderRadius: 6,
            padding: "10px 20px",
            fontWeight: 600,
            fontSize: 13,
            cursor: isGenerating ? "wait" : !masterRefDataUrl ? "not-allowed" : "pointer",
          }}
        >
          {isGenerating ? "⚡ Generating 3D Multi-View Pass…" : "⚡ Generate 3D Multi-View Turnaround"}
        </button>
      </div>

      {/* Composite Contact Sheet Strip (if available) */}
      {sheetDataUrl && (
        <div
          style={{
            background: "#161b22",
            border: "1px solid #30363d",
            borderRadius: 8,
            padding: "12px 16px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span style={{ fontSize: 12, fontWeight: 600, color: "#8b949e" }}>
            3D Multi-View Turnaround Contact Strip:
          </span>
          <img
            src={sheetDataUrl}
            alt="MultiView Sheet Preview"
            style={{ maxHeight: 48, borderRadius: 4, border: "1px solid #30363d", imageRendering: "pixelated" }}
          />
        </div>
      )}

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
