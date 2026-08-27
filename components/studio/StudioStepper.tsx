"use client";

import React from "react";

export type StudioStep = 1 | 2 | 3 | 4 | 5;

export interface StudioStepperProps {
  currentStep: StudioStep;
  onSelectStep: (step: StudioStep) => void;
  completedSteps: number[];
}

const STEPS = [
  { id: 1 as StudioStep, number: "01", title: "Concept Intake", blurb: "Archetype & Master Ref" },
  { id: 2 as StudioStep, number: "02", title: "3-Way Turnaround", blurb: "S, E, N Facings" },
  { id: 3 as StudioStep, number: "03", title: "Moveset Matrix", blurb: "Action Animations" },
  { id: 4 as StudioStep, number: "04", title: "Contact Sheet QA", blurb: "Anchor & Inpaint" },
  { id: 5 as StudioStep, number: "05", title: "Export Atlas", blurb: "20-Color Crush" },
];

export function StudioStepper({ currentStep, onSelectStep, completedSteps }: StudioStepperProps) {
  return (
    <nav
      style={{
        background: "#161b22",
        borderBottom: "1px solid #21262d",
        padding: "16px 24px",
        display: "grid",
        gridTemplateColumns: "repeat(5, 1fr)",
        gap: 12,
      }}
    >
      {STEPS.map((step) => {
        const isActive = currentStep === step.id;
        const isDone = completedSteps.includes(step.id);

        return (
          <div
            key={step.id}
            onClick={() => onSelectStep(step.id)}
            style={{
              background: isActive ? "#0d1117" : "#11141a",
              border: `1px solid ${isActive ? "#58a6ff" : isDone ? "#238636" : "#30363d"}`,
              borderRadius: 6,
              padding: "10px 14px",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 12,
              transition: "all 0.15s ease",
            }}
          >
            <div
              style={{
                width: 28,
                height: 28,
                borderRadius: "50%",
                background: isActive ? "#1f6feb" : isDone ? "#238636" : "#21262d",
                color: "#fff",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 12,
                fontWeight: 700,
              }}
            >
              {isDone ? "✓" : step.number}
            </div>

            <div style={{ display: "flex", flexDirection: "column" }}>
              <span
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: isActive ? "#58a6ff" : "#f0f6fc",
                }}
              >
                {step.title}
              </span>
              <span style={{ fontSize: 11, color: "#8b949e" }}>{step.blurb}</span>
            </div>
          </div>
        );
      })}
    </nav>
  );
}
