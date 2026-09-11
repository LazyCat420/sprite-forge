"use client";

import dynamic from "next/dynamic";
import React from "react";

const ForgePanel = dynamic(() => import("../../components/ForgePanel"), { ssr: false });

/**
 * /forge — the sprite generation panel: ComfyUI backend status, model
 * manager (download / swap the pipeline's weights), benchmark tests,
 * and rotate/animate/edit character library.
 */
export default function ForgePage() {
  return <ForgePanel />;
}
