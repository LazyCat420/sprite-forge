"use client";

import React, { useState } from "react";
import { S, GREEN, AMBER, RED } from "./theme";
import type { Mode } from "./types";
import { fileToB64 } from "./api";
import type { SlotId } from "./GenerateCard";

function ImageSlot({
  label,
  b64,
  hint,
  onSet,
  onClear,
}: {
  label: string;
  b64: string | null;
  hint?: string;
  onSet: (b64: string) => void;
  onClear: () => void;
}) {
  const [drag, setDrag] = useState(false);
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={async (e) => {
        e.preventDefault();
        setDrag(false);
        const f = e.dataTransfer.files?.[0];
        if (f) onSet(await fileToB64(f));
      }}
      style={{ textAlign: "center" }}
    >
      <label
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          width: 104,
          height: 104,
          borderRadius: 4,
          cursor: "pointer",
          border: `1px dashed ${drag ? "#8fdd9f" : "#2c303b"}`,
          ...(b64 ? {} : { background: "#0d0f14" }),
        }}
      >
        {b64 ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={b64}
            alt={label}
            style={{ width: 100, height: 100, objectFit: "contain", background: "#fff", borderRadius: 3, imageRendering: "pixelated" }}
          />
        ) : (
          <span style={{ ...S.note, padding: 4, textAlign: "center", fontSize: 11 }}>
            {label}
            <br />
            <span style={{ ...S.btn, display: "inline-block", marginTop: 4, pointerEvents: "none", fontSize: 10 }}>browse…</span>
            <br />
            <span style={{ fontSize: 10 }}>{hint ?? "optional"}</span>
          </span>
        )}
        <input
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) onSet(await fileToB64(f));
            e.target.value = "";
          }}
        />
      </label>
      {b64 && (
        <button type="button" onClick={onClear} style={{ ...S.btn, ...S.btnGhost, fontSize: 10, marginTop: 2 }}>
          clear
        </button>
      )}
    </div>
  );
}

export function ModelTestCard({
  modes,
  images,
  onSetImage,
  onClearImage,
  onGenerate,
  busy,
  activeCharacter,
  onClearMemory,
}: {
  modes: Mode[];
  images: Record<SlotId, string | null>;
  onSetImage: (slot: SlotId, b64: string) => void;
  onClearImage: (slot: SlotId) => void;
  onGenerate: (req: { mode: string; params: Record<string, string>; prompt?: string; seed?: number; small?: boolean }) => Promise<void>;
  busy: boolean;
  activeCharacter: string | null;
  onClearMemory?: () => Promise<void>;
}) {
  const [modelChoice, setModelChoice] = useState<"h3" | "wan" | "wan5b">("h3");
  const [preset, setPreset] = useState("walk");
  const [actionText, setActionText] = useState("");
  const [frames, setFrames] = useState("5");
  const [tiled, setTiled] = useState(false);
  const [tileSize, setTileSize] = useState(512);
  const [seed, setSeed] = useState<number | "">("");
  const [promptText, setPromptText] = useState("pix3lwalk, Pixel art game sprite walking with a springy exaggerated stride, knees lifting high, consistent colors, plain white background.");
  const [showImageOptions, setShowImageOptions] = useState(false);
  const [clearingMem, setClearingMem] = useState(false);

  const handleRunSingle = async () => {
    const modeId = modelChoice === "h3" ? "h3" : "animate";
    const params: Record<string, string> = {
      preset,
      action: actionText,
      frames,
      tiled: tiled ? "true" : "false",
      tileSize: String(tileSize),
    };

    await onGenerate({
      mode: modeId,
      params,
      prompt: promptText.trim() || undefined,
      seed: typeof seed === "number" ? seed : undefined,
      small: modelChoice === "wan5b",
    });
  };

  const handleRunCompare = async () => {
    const testSeed = typeof seed === "number" ? seed : Math.floor(Math.random() * 1e6);
    
    // 1. Run H3 Text-to-Video
    await onGenerate({
      mode: "h3",
      params: { preset, action: actionText, frames: "5", tiled: "false" },
      prompt: promptText.trim() || undefined,
      seed: testSeed,
    });

    // 2. Run Wan 2.2
    await onGenerate({
      mode: "animate",
      params: { preset, action: actionText, frames: "21" },
      prompt: promptText.trim() || undefined,
      seed: testSeed,
    });
  };

  const handleMemoryPurge = async () => {
    setClearingMem(true);
    try {
      if (onClearMemory) {
        await onClearMemory();
      } else {
        await fetch("/api/comfy/server", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "free" }),
        }).catch(() => {});
      }
    } finally {
      setClearingMem(false);
    }
  };

  return (
    <div style={S.card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 16, color: "#fff" }}>
          🧪 text-to-video & model test lab
          {activeCharacter && <span style={S.chip(GREEN.fg, GREEN.bg)}>character: {activeCharacter}</span>}
        </h3>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button
            type="button"
            onClick={handleMemoryPurge}
            disabled={clearingMem}
            style={{ ...S.btn, ...S.btnGhost, color: RED.fg, borderColor: "#483028", fontSize: 11 }}
          >
            {clearingMem ? "purging RAM…" : "clear memory 🧹"}
          </button>
          <span style={S.note}>pure text-to-video test & benchmarking</span>
        </div>
      </div>

      {/* Model Selection Row */}
      <div style={{ display: "flex", gap: 16, marginBottom: 16, background: "#11141c", padding: 12, borderRadius: 4 }}>
        <span style={{ fontSize: 13, fontWeight: "bold", color: "#ccc", alignSelf: "center" }}>model engine:</span>
        
        <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
          <input
            type="radio"
            name="modelChoice"
            checked={modelChoice === "h3"}
            onChange={() => {
              setModelChoice("h3");
              setFrames("5");
            }}
          />
          <span style={{ color: modelChoice === "h3" ? GREEN.fg : "#aaa", fontWeight: "bold" }}>
            MiniMax H3 (FL2VA Q3_K_M)
          </span>
          <span style={{ fontSize: 11, color: "#666" }}>~11.6s 5f</span>
        </label>

        <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
          <input
            type="radio"
            name="modelChoice"
            checked={modelChoice === "wan"}
            onChange={() => {
              setModelChoice("wan");
              setFrames("21");
            }}
          />
          <span style={{ color: modelChoice === "wan" ? GREEN.fg : "#aaa", fontWeight: "bold" }}>
            Wan 2.2 I2V-A14B
          </span>
          <span style={{ fontSize: 11, color: "#666" }}>2x Experts</span>
        </label>

        <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
          <input
            type="radio"
            name="modelChoice"
            checked={modelChoice === "wan5b"}
            onChange={() => {
              setModelChoice("wan5b");
              setFrames("21");
            }}
          />
          <span style={{ color: modelChoice === "wan5b" ? GREEN.fg : "#aaa", fontWeight: "bold" }}>
            Wan 2.2 TI2V-5B (Fast Small)
          </span>
        </label>
      </div>

      {/* Primary Text-to-Video Form */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {/* Text Prompt Input */}
        <div>
          <label style={{ display: "block", fontSize: 12, fontWeight: "bold", color: "#aaa", marginBottom: 4 }}>
            text prompt (what to generate):
          </label>
          <textarea
            rows={2}
            value={promptText}
            onChange={(e) => setPromptText(e.target.value)}
            placeholder="e.g. pix3lwalk, Pixel art game sprite walking with a springy stride, plain white background."
            style={{ ...S.input, width: "100%", fontFamily: "inherit", resize: "vertical" }}
          />
        </div>

        {/* Parameters Grid */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <span style={{ width: 70, fontSize: 12, color: "#aaa" }}>action:</span>
            <select
              value={preset}
              onChange={(e) => setPreset(e.target.value)}
              style={S.input}
            >
              <option value="walk">walk (side view)</option>
              <option value="attack">attack (lunge)</option>
              <option value="stumble">stumble (hurt)</option>
              <option value="death">death (collapse)</option>
              <option value="run">run (sprint)</option>
              <option value="idle">idle (breathing)</option>
              <option value="custom">custom action</option>
            </select>
          </div>

          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <span style={{ width: 70, fontSize: 12, color: "#aaa" }}>frames:</span>
            <select
              value={frames}
              onChange={(e) => setFrames(e.target.value)}
              style={S.input}
            >
              <option value="5">5 frames (fast MiniMax H3 grid)</option>
              <option value="21">21 frames (standard Wan grid)</option>
            </select>
          </div>
        </div>

        {/* VAE & Seed Row */}
        <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap", background: "#11141c", padding: 8, borderRadius: 4 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span style={{ fontSize: 12, color: "#aaa" }}>vae decode:</span>
            <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer", fontSize: 12, color: "#ccc" }}>
              <input type="radio" name="tiled" checked={!tiled} onChange={() => setTiled(false)} />
              Standard (VAEDecode)
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer", fontSize: 12, color: "#ccc" }}>
              <input type="radio" name="tiled" checked={tiled} onChange={() => setTiled(true)} />
              Tiled (VAEDecodeTiled)
            </label>
          </div>

          {tiled && (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 11, color: "#888" }}>tile size: {tileSize}px</span>
              <input
                type="range"
                min="256"
                max="1024"
                step="128"
                value={tileSize}
                onChange={(e) => setTileSize(Number(e.target.value))}
              />
            </div>
          )}

          <div style={{ display: "flex", gap: 8, alignItems: "center", marginLeft: "auto" }}>
            <span style={{ fontSize: 12, color: "#aaa" }}>seed:</span>
            <input
              type="number"
              placeholder="random"
              value={seed}
              onChange={(e) => setSeed(e.target.value === "" ? "" : Number(e.target.value))}
              style={{ ...S.input, width: 90 }}
            />
            <button
              type="button"
              onClick={() => setSeed(Math.floor(Math.random() * 1e6))}
              style={S.btn}
            >
              🎲
            </button>
          </div>
        </div>

        {/* Optional Init Image Accordion */}
        <div>
          <button
            type="button"
            onClick={() => setShowImageOptions(!showImageOptions)}
            style={{ ...S.btn, ...S.btnGhost, fontSize: 11, padding: "2px 6px" }}
          >
            {showImageOptions ? "▼ hide image conditioning" : "▶ attach optional init / end image conditioning"}
          </button>

          {showImageOptions && (
            <div style={{ display: "flex", gap: 12, marginTop: 8, padding: 8, background: "#0e1017", borderRadius: 4 }}>
              <ImageSlot
                label="init frame"
                b64={images.init}
                hint="start image"
                onSet={(b64) => onSetImage("init", b64)}
                onClear={() => onClearImage("init")}
              />
              <ImageSlot
                label="end frame"
                b64={images.end}
                hint="end pin"
                onSet={(b64) => onSetImage("end", b64)}
                onClear={() => onClearImage("end")}
              />
            </div>
          )}
        </div>
      </div>

      {/* Action Buttons */}
      <div style={{ display: "flex", gap: 12, marginTop: 16, paddingTop: 12, borderTop: "1px solid #1a1d26" }}>
        <button
          type="button"
          onClick={handleRunSingle}
          disabled={busy}
          style={{
            ...S.btn,
            ...S.btnGreen,
            padding: "8px 20px",
            fontSize: 14,
            opacity: busy ? 0.5 : 1,
          }}
        >
          {busy ? "generating video…" : `🚀 generate ${modelChoice.toUpperCase()} video`}
        </button>

        <button
          type="button"
          onClick={handleRunCompare}
          disabled={busy}
          style={{
            ...S.btn,
            borderColor: AMBER.fg,
            color: AMBER.fg,
            padding: "8px 16px",
            fontSize: 13,
            opacity: busy ? 0.5 : 1,
          }}
        >
          ⚡ compare H3 vs Wan 2.2 (side-by-side)
        </button>
      </div>
    </div>
  );
}
