"use client";

import React, { useState } from "react";
import { StudioHeader } from "@/components/studio/StudioHeader";
import { StudioStepper, type StudioStep } from "@/components/studio/StudioStepper";
import { Step1_Intake } from "@/components/studio/Step1_Intake";
import { Step2_Turnaround } from "@/components/studio/Step2_Turnaround";
import { Step3_MovesetMatrix } from "@/components/studio/Step3_MovesetMatrix";
import { Step4_ContactSheetQA } from "@/components/studio/Step4_ContactSheetQA";
import { Step5_ExportAtlas } from "@/components/studio/Step5_ExportAtlas";

export default function StudioPage() {
  const [character, setCharacter] = useState("knight");
  const [step, setStep] = useState<StudioStep>(1);
  const [completedSteps, setCompletedSteps] = useState<number[]>([1]);

  const [activeClip, setActiveClip] = useState<{ clip: string; facing: "S" | "E" | "N" }>({
    clip: "walk",
    facing: "S",
  });

  const markStepDone = (s: number) => {
    if (!completedSteps.includes(s)) {
      setCompletedSteps([...completedSteps, s]);
    }
  };

  const handleAdvance = (nextStep: StudioStep) => {
    markStepDone(step);
    setStep(nextStep);
  };

  const handleInspectClip = (clip: string, facing: "S" | "E" | "N") => {
    setActiveClip({ clip, facing });
    markStepDone(3);
    setStep(4);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
      {/* Top Header with Character Picker & DGX Spark Cluster Liveness */}
      <StudioHeader
        activeCharacter={character}
        onSelectCharacter={(c) => {
          setCharacter(c);
          setStep(1);
          setCompletedSteps([1]);
        }}
        onNewCharacter={() => {
          const name = prompt("Enter new character name (e.g. Paladin, Necromancer):");
          if (name) {
            setCharacter(name.toLowerCase().replace(/\s+/g, "_"));
            setStep(1);
            setCompletedSteps([1]);
          }
        }}
      />

      {/* 5-Step Guided Progress Wizard */}
      <StudioStepper
        currentStep={step}
        onSelectStep={(s) => setStep(s)}
        completedSteps={completedSteps}
      />

      {/* Main Studio Viewport */}
      <main style={{ flex: 1, padding: "24px 32px", maxWidth: 1200, margin: "0 auto", width: "100%", boxSizing: "border-box" }}>
        {step === 1 && (
          <Step1_Intake
            character={character}
            onAdvance={() => handleAdvance(2)}
          />
        )}

        {step === 2 && (
          <Step2_Turnaround
            character={character}
            onAdvance={() => handleAdvance(3)}
            onBack={() => setStep(1)}
          />
        )}

        {step === 3 && (
          <Step3_MovesetMatrix
            character={character}
            onAdvance={() => handleAdvance(4)}
            onBack={() => setStep(2)}
            onInspectClip={handleInspectClip}
          />
        )}

        {step === 4 && (
          <Step4_ContactSheetQA
            character={character}
            clip={activeClip.clip}
            facing={activeClip.facing}
            onAdvance={() => handleAdvance(5)}
            onBack={() => setStep(3)}
          />
        )}

        {step === 5 && (
          <Step5_ExportAtlas
            character={character}
            onBack={() => setStep(4)}
            onRestart={() => {
              setStep(1);
              setCompletedSteps([1]);
            }}
          />
        )}
      </main>
    </div>
  );
}
