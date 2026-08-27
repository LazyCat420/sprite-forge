"use client";

import React, { useState } from "react";

export interface Step2TurnaroundProps {
  character: string;
  masterRefDataUrl: string | null;
  onAdvance: () => void;
  onBack: () => void;
}

export function Step2_Turnaround({
  character,
  masterRefDataUrl,
  onAdvance,
  onBack,
}: Step2TurnaroundProps) {
  const [isGeneratingE, setIsGeneratingE] = useState(false);
  const [isGeneratingN, setIsGeneratingN] = useState(false);
  const [generationError, setGenerationError] = useState<string | null>(null);

  const [eDataUrl, setEDataUrl] = useState<string | null>(null);
  const [nDataUrl, setNDataUrl] = useState<string | null>(null);
  const [denoise, setDenoise] = useState(0.65);

  const handleGenerateTurnaround = async () => {
    setGenerationError(null);
    setIsGeneratingE(true);
    setIsGeneratingN(true);

    const generateAngle = async (facing: "E" | "N", setter: (url: string) => void) => {
      try {
        const res = await fetch("/api/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: "turnaround",
            character,
            facing,
            initImageDataUrl: masterRefDataUrl,
            denoise,
          }),
        });

        const data = await res.json();
        if (!res.ok || !data.ok) {
          throw new Error(`${facing}-Facing: ${data.error || "Generation failed"}`);
        }
        if (data.imageDataUrl) {
          setter(data.imageDataUrl);
        }
      } catch (err: any) {
        console.error(err);
        setGenerationError((prev) => (prev ? `${prev} | ${err.message}` : err.message));
      } finally {
        if (facing === "E") setIsGeneratingE(false);
        if (facing === "N") setIsGeneratingN(false);
      }
    };

    // Dispatch both angles concurrently to Gold Spark and MSI Spark
    await Promise.allSettled([
      generateAngle("E", setEDataUrl),
      generateAngle("N", setNDataUrl),
    ]);
  };

  const isGenerating = isGeneratingE || isGeneratingN;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div>
        <h2 style={{ fontSize: 20, fontWeight: 700, color: "#f0f6fc", margin: "0 0 6px" }}>
          Step 2: 3-Facing Turnaround Generation (S, E, N)
        </h2>
        <p style={{ fontSize: 13, color: "#8b949e", margin: 0 }}>
          Generates East (Side Profile) and North (Back Facing) angles conditioned on the Step 1 Master Reference image across Gold Spark and MSI Spark in parallel.
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
            }}
          >
            {masterRefDataUrl ? (
              <img
                src={masterRefDataUrl}
                alt="S Facing Master Reference"
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
          <span style={{ fontSize: 11, color: eDataUrl ? "#8fdd9f" : isGeneratingE ? "#58a6ff" : "#8b949e" }}>
            {eDataUrl ? "✓ Identity & Baseline Locked" : isGeneratingE ? "Rendering…" : "Pending Render"}
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
              width: 110,
              height: 160,
              background: "#0d1117",
              border: `1px solid ${nDataUrl ? "#238636" : "#30363d"}`,
              borderRadius: 4,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              position: "relative",
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
          <span style={{ fontSize: 11, color: nDataUrl ? "#8fdd9f" : isGeneratingN ? "#58a6ff" : "#8b949e" }}>
            {nDataUrl ? "✓ Identity & Baseline Locked" : isGeneratingN ? "Rendering…" : "Pending Render"}
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
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 13, color: "#f0f6fc" }}>
              Turnaround Dual-Node Generator (Img2Img Init)
            </div>
            <div style={{ fontSize: 12, color: "#8b949e" }}>
              Dispatches E to Gold Spark and N to MSI Spark concurrently.
            </div>
          </div>

          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#c9d1d9" }}>
            <span>Denoise: {denoise}</span>
            <input
              type="range"
              min="0.45"
              max="0.80"
              step="0.05"
              value={denoise}
              onChange={(e) => setDenoise(parseFloat(e.target.value))}
            />
          </label>
        </div>

        <button
          onClick={handleGenerateTurnaround}
          disabled={isGenerating || !masterRefDataUrl}
          style={{
            background: isGenerating ? "#1f6feb" : "#238636",
            border: `1px solid ${isGenerating ? "#388bfd" : "#2ea043"}`,
            color: "#fff",
            borderRadius: 6,
            padding: "8px 16px",
            fontWeight: 600,
            cursor: isGenerating ? "wait" : !masterRefDataUrl ? "not-allowed" : "pointer",
          }}
        >
          {isGenerating ? "⚡ Rendering (Gold + MSI Spark)…" : "⚡ Generate Missing Angles (E + N)"}
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
