"use client";

import React, { useState } from "react";

export interface Step1IntakeProps {
  character: string;
  onAdvance: () => void;
}

const ARCHETYPES = [
  {
    id: "knight",
    name: "Pinball Knight",
    icon: "🗡️",
    desc: "Steel plate armor, open-visor helm, greatsword. Hero tank.",
    defaultPrompt: "pixel art 32x48 sprite of a heroic knight in steel plate armor, open-visor helm, holding a broadsword, flat green chroma background",
  },
  {
    id: "goblin",
    name: "Stiltneck Goblin",
    icon: "👺",
    desc: "Agile, elongated neck, leather tunic, twin daggers.",
    defaultPrompt: "pixel art 32x48 sprite of a lanky stiltneck goblin with twin daggers, ragged leather armor, flat green chroma background",
  },
  {
    id: "undead",
    name: "Zombie Shambler",
    icon: "🧟",
    desc: "Decaying rot, torn clothing, heavy dragging gait.",
    defaultPrompt: "pixel art 32x48 sprite of a decaying shambling zombie, torn tattered clothes, asymmetric silhouette, flat green chroma background",
  },
  {
    id: "beaver",
    name: "Beaver Brute",
    icon: "🦫",
    desc: "Heavy woodland beast, club weapon, grounded stance.",
    defaultPrompt: "pixel art 32x48 sprite of a stout armored beaver warrior with a wooden spiked club, flat green chroma background",
  },
  {
    id: "custom",
    name: "Custom Actor",
    icon: "✨",
    desc: "Start from scratch with custom text prompt or image upload.",
    defaultPrompt: "pixel art 32x48 sprite of a fantasy character, clean silhouette, flat green chroma background",
  },
];

export function Step1_Intake({ character, onAdvance }: Step1IntakeProps) {
  const [selectedArchetype, setSelectedArchetype] = useState("knight");
  const [prompt, setPrompt] = useState(ARCHETYPES[0].defaultPrompt);
  const [isGenerating, setIsGenerating] = useState(false);
  const [refImage, setRefImage] = useState<string | null>(null);

  const handleArchetypeSelect = (archId: string) => {
    setSelectedArchetype(archId);
    const arch = ARCHETYPES.find((a) => a.id === archId);
    if (arch) setPrompt(arch.defaultPrompt);
  };

  const handleGenerateConcept = async () => {
    setIsGenerating(true);
    // Simulate generation or dispatch to DGX Spark
    setTimeout(() => {
      setRefImage("concept_ready");
      setIsGenerating(false);
    }, 1200);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {/* Header */}
      <div>
        <h2 style={{ fontSize: 20, fontWeight: 700, color: "#f0f6fc", margin: "0 0 6px" }}>
          Step 1: Character Concept & Archetype Intake
        </h2>
        <p style={{ fontSize: 13, color: "#8b949e", margin: 0 }}>
          Choose a pre-configured character archetype or draft a custom concept. This locks the master reference frame for all 3 turnaround angles and animation movesets.
        </p>
      </div>

      {/* Archetype Cards Grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14 }}>
        {ARCHETYPES.map((arch) => {
          const isSelected = selectedArchetype === arch.id;
          return (
            <div
              key={arch.id}
              onClick={() => handleArchetypeSelect(arch.id)}
              style={{
                background: isSelected ? "#0d1117" : "#161b22",
                border: `2px solid ${isSelected ? "#58a6ff" : "#30363d"}`,
                borderRadius: 8,
                padding: 16,
                cursor: "pointer",
                display: "flex",
                flexDirection: "column",
                gap: 8,
                transition: "all 0.15s ease",
              }}
            >
              <div style={{ fontSize: 28 }}>{arch.icon}</div>
              <div style={{ fontWeight: 600, fontSize: 14, color: isSelected ? "#58a6ff" : "#f0f6fc" }}>
                {arch.name}
              </div>
              <div style={{ fontSize: 12, color: "#8b949e", lineHeight: 1.4 }}>{arch.desc}</div>
            </div>
          );
        })}
      </div>

      {/* Concept Editor Card */}
      <div
        style={{
          background: "#161b22",
          border: "1px solid #30363d",
          borderRadius: 8,
          padding: 20,
          display: "grid",
          gridTemplateColumns: "1fr 280px",
          gap: 20,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <label>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#c9d1d9", marginBottom: 6 }}>
              Generation Prompt (Targeting DGX Spark Qwen/Wan):
            </div>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              style={{
                width: "100%",
                background: "#0d1117",
                border: "1px solid #30363d",
                borderRadius: 6,
                color: "#c9d1d9",
                padding: 10,
                fontSize: 13,
                fontFamily: "inherit",
              }}
            />
          </label>

          <div style={{ display: "flex", gap: 10 }}>
            <button
              onClick={handleGenerateConcept}
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
              {isGenerating ? "⚡ Generating on DGX Spark…" : "⚡ Generate Base Concept"}
            </button>

            <button
              style={{
                background: "#21262d",
                border: "1px solid #30363d",
                color: "#c9d1d9",
                borderRadius: 6,
                padding: "8px 16px",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              📁 Upload Reference PNG
            </button>
          </div>
        </div>

        {/* Master Reference Preview */}
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
            minHeight: 180,
          }}
        >
          <div style={{ fontSize: 12, color: "#8b949e", marginBottom: 8, fontWeight: 600 }}>
            Master Reference (S-Facing)
          </div>
          <div
            style={{
              width: 64,
              height: 96,
              background: "#1f6feb",
              borderRadius: 4,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 24,
            }}
          >
            {ARCHETYPES.find((a) => a.id === selectedArchetype)?.icon ?? "🗡️"}
          </div>
          <div style={{ fontSize: 11, color: "#8fdd9f", marginTop: 8 }}>
            ✓ Canvas: 32x48 · Baseline: y=44
          </div>
        </div>
      </div>

      {/* Advance Footer */}
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
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
          Proceed to Step 2: 3-Way Turnaround ➔
        </button>
      </div>
    </div>
  );
}
