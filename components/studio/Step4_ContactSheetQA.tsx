"use client";

import React, { useState } from "react";
import type { SpriteClipGraph, FrameSlot } from "@/engine/graph/revision-graph";

export interface Step4ContactSheetQAProps {
  character: string;
  clip: string;
  facing: "S" | "E" | "N";
  onAdvance: () => void;
  onBack: () => void;
}

export function Step4_ContactSheetQA({
  character,
  clip,
  facing,
  onAdvance,
  onBack,
}: Step4ContactSheetQAProps) {
  const [selectedSlotIndex, setSelectedSlotIndex] = useState<number | null>(null);

  // Generate synthetic mock slots for immediate interactive review
  const [slots, setSlots] = useState<FrameSlot[]>(
    Array.from({ length: 8 }, (_, i) => ({
      slot: i,
      acceptedRevisionId: i === 2 ? null : `rev-0`,
      status: i === 2 ? "flagged" : "accepted",
      issues: i === 2 ? ["head-shift"] : [],
      revisions: [
        {
          id: `rev-0`,
          sourceType: "initial_generation",
          imagePath: "",
          analysis: { issues: i === 2 ? ["head-shift"] : [] },
          authoredAt: new Date().toISOString(),
        },
      ],
    }))
  );

  const handlePromote = (slotIndex: number) => {
    setSlots((prev) =>
      prev.map((s, idx) =>
        idx === slotIndex
          ? { ...s, status: "accepted", acceptedRevisionId: `rev-${s.revisions.length - 1}`, issues: [] }
          : s
      )
    );
    setSelectedSlotIndex(null);
  };

  const handleRepairSlot = (slotIndex: number) => {
    setSlots((prev) =>
      prev.map((s, idx) =>
        idx === slotIndex
          ? {
              ...s,
              status: "accepted",
              acceptedRevisionId: `rev-inpaint-fixed`,
              issues: [],
              revisions: [
                ...s.revisions,
                {
                  id: "rev-inpaint-fixed",
                  sourceType: "inpaint_patch",
                  imagePath: "",
                  analysis: { issues: [] },
                  authoredAt: new Date().toISOString(),
                },
              ],
            }
          : s
      )
    );
    setSelectedSlotIndex(null);
  };

  const allAccepted = slots.every((s) => s.status === "accepted");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h2 style={{ fontSize: 20, fontWeight: 700, color: "#f0f6fc", margin: "0 0 6px" }}>
            Step 4: Contact Sheet QA & Anchor Debugger ({character} · {clip} {facing})
          </h2>
          <p style={{ fontSize: 13, color: "#8b949e", margin: 0 }}>
            Inspect ground baseline alignment, onion skinning, and flagged frame cels. Click any frame to open the Anchor Debugger or draw repair masks.
          </p>
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <span
            style={{
              background: allAccepted ? "rgba(63, 185, 80, 0.15)" : "rgba(210, 153, 34, 0.15)",
              border: `1px solid ${allAccepted ? "#238636" : "#d29922"}`,
              color: allAccepted ? "#8fdd9f" : "#ffd9a0",
              padding: "6px 14px",
              borderRadius: 6,
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            {allAccepted ? "✓ All Slots Accepted (8/8)" : "Reviewing Flagged Slots"}
          </span>
        </div>
      </div>

      {/* Frame Slots Grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))",
          gap: 12,
        }}
      >
        {slots.map((slot, idx) => {
          const isAccepted = slot.status === "accepted";
          const isFlagged = slot.status === "flagged";

          return (
            <div
              key={slot.slot}
              onClick={() => setSelectedSlotIndex(idx)}
              style={{
                background: "#161b22",
                border: `2px solid ${isAccepted ? "#238636" : isFlagged ? "#d29922" : "#30363d"}`,
                borderRadius: 6,
                padding: 10,
                cursor: "pointer",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 6,
                transition: "all 0.15s ease",
              }}
            >
              <div style={{ width: "100%", display: "flex", justifyContent: "space-between", fontSize: 11 }}>
                <span style={{ fontWeight: 600, color: "#8b949e" }}>Slot {slot.slot}</span>
                <span style={{ color: isAccepted ? "#8fdd9f" : "#ffd9a0", fontWeight: 600 }}>
                  {slot.status}
                </span>
              </div>

              {/* Cel Preview Box */}
              <div
                style={{
                  width: "100%",
                  height: 110,
                  background: "#0d1117",
                  borderRadius: 4,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  position: "relative",
                }}
              >
                <div
                  style={{
                    width: 44,
                    height: 76,
                    background: isAccepted ? "#3fb950" : "#d29922",
                    borderRadius: 2,
                  }}
                />
                {/* Ground Crosshair Indicator */}
                <div
                  style={{
                    position: "absolute",
                    bottom: 10,
                    left: 0,
                    right: 0,
                    height: 1,
                    background: "#44ff88",
                    opacity: 0.6,
                  }}
                />
              </div>

              {slot.issues.length > 0 && (
                <span style={{ fontSize: 10, color: "#ff7b72", fontWeight: 600 }}>
                  ⚠️ {slot.issues.join(", ")}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* Anchor Debugger Inspector Modal */}
      {selectedSlotIndex !== null && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.85)",
            zIndex: 9999,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div
            style={{
              background: "#0d1117",
              border: "1px solid #30363d",
              borderRadius: 8,
              width: 800,
              padding: 20,
              display: "flex",
              flexDirection: "column",
              gap: 16,
              color: "#c9d1d9",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontWeight: 600, fontSize: 16, color: "#f0f6fc" }}>
                Sprite Anchor Debugger — Slot {slots[selectedSlotIndex].slot}
              </div>
              <button
                onClick={() => setSelectedSlotIndex(null)}
                style={{ background: "transparent", border: "none", color: "#8b949e", fontSize: 16, cursor: "pointer" }}
              >
                ✕
              </button>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 280px", gap: 16 }}>
              {/* Canvas Viewport */}
              <div
                style={{
                  background: "#161b22",
                  border: "1px solid #30363d",
                  borderRadius: 6,
                  height: 300,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  position: "relative",
                }}
              >
                <div style={{ width: 96, height: 160, background: "#3fb950", borderRadius: 4 }} />
                <div style={{ position: "absolute", bottom: 40, left: 0, right: 0, height: 2, background: "#44ff88" }} />
                <div style={{ position: "absolute", bottom: 32, color: "#44ff88", fontSize: 11 }}>
                  Ground Baseline (y=44)
                </div>
              </div>

              {/* Tools & Repair Panel */}
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div style={{ fontWeight: 600, fontSize: 13, color: "#58a6ff" }}>
                  ⚡ Smart Auto-Part Inpaint
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                  <button
                    onClick={() => handleRepairSlot(selectedSlotIndex)}
                    style={{ background: "#21262d", border: "1px solid #30363d", color: "#c9d1d9", padding: "6px", borderRadius: 4, cursor: "pointer" }}
                  >
                    Head Slice
                  </button>
                  <button
                    onClick={() => handleRepairSlot(selectedSlotIndex)}
                    style={{ background: "#21262d", border: "1px solid #30363d", color: "#c9d1d9", padding: "6px", borderRadius: 4, cursor: "pointer" }}
                  >
                    Torso Slice
                  </button>
                  <button
                    onClick={() => handleRepairSlot(selectedSlotIndex)}
                    style={{ background: "#21262d", border: "1px solid #30363d", color: "#c9d1d9", padding: "6px", borderRadius: 4, cursor: "pointer" }}
                  >
                    Weapon
                  </button>
                  <button
                    onClick={() => handleRepairSlot(selectedSlotIndex)}
                    style={{ background: "#21262d", border: "1px solid #30363d", color: "#c9d1d9", padding: "6px", borderRadius: 4, cursor: "pointer" }}
                  >
                    Feet
                  </button>
                </div>

                <button
                  onClick={() => handleRepairSlot(selectedSlotIndex)}
                  style={{
                    background: "#238636",
                    border: "1px solid #2ea043",
                    color: "#fff",
                    borderRadius: 6,
                    padding: "8px 12px",
                    fontWeight: 600,
                    cursor: "pointer",
                    marginTop: 8,
                  }}
                >
                  ✨ Run Masked Inpaint on DGX Spark
                </button>

                <button
                  onClick={() => handlePromote(selectedSlotIndex)}
                  style={{
                    background: "#1f6feb",
                    border: "1px solid #388bfd",
                    color: "#fff",
                    borderRadius: 6,
                    padding: "8px 12px",
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  ✅ Accept Active Candidate
                </button>
              </div>
            </div>
          </div>
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
          ← Back to Moveset Matrix
        </button>

        <button
          onClick={onAdvance}
          disabled={!allAccepted}
          style={{
            background: allAccepted ? "#1f6feb" : "#21262d",
            border: `1px solid ${allAccepted ? "#388bfd" : "#30363d"}`,
            color: allAccepted ? "#fff" : "#8b949e",
            borderRadius: 6,
            padding: "10px 24px",
            fontSize: 14,
            fontWeight: 600,
            cursor: allAccepted ? "pointer" : "not-allowed",
          }}
        >
          Proceed to Step 5: Export Atlas ➔
        </button>
      </div>
    </div>
  );
}
