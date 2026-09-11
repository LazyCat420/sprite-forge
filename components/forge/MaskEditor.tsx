"use client";

/**
 * Brush a mask over the init frame — the touch-up mode's "only fix THIS"
 * surface. White = regenerate, black = keep; the server feeds it to
 * SetLatentNoiseMask via the red channel, and composites the untouched
 * region back from the source pixels, so a sloppy brush edge costs nothing
 * outside the brush.
 *
 * Two canvases: the frame underneath, the mask on top rendered translucent
 * red so the user sees art and selection at once. Export flattens the mask
 * onto black at the image's NATURAL size — the latent mask must align with
 * the uploaded init pixel-for-pixel, so display scaling never touches it.
 */
import React, { useEffect, useRef, useState } from "react";
import { S } from "./theme";

export function MaskEditor({
  imageB64,
  onDone,
  onCancel,
}: {
  imageB64: string;
  onDone: (maskB64: string) => void;
  onCancel: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const maskRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0, scale: 1 });
  const [brush, setBrush] = useState(48);
  const [erase, setErase] = useState(false);
  const [painted, setPainted] = useState(false);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 640 / img.naturalWidth, 560 / img.naturalHeight);
      setSize({ w: img.naturalWidth, h: img.naturalHeight, scale });
    };
    img.src = imageB64;
  }, [imageB64]);

  const toCanvas = (e: React.PointerEvent) => {
    const rect = maskRef.current!.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * size.w,
      y: ((e.clientY - rect.top) / rect.height) * size.h,
    };
  };

  const stroke = (from: { x: number; y: number }, to: { x: number; y: number }) => {
    const ctx = maskRef.current!.getContext("2d")!;
    ctx.globalCompositeOperation = erase ? "destination-out" : "source-over";
    ctx.strokeStyle = "rgba(255,60,60,0.85)";
    ctx.fillStyle = "rgba(255,60,60,0.85)";
    ctx.lineWidth = brush;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    setPainted(true);
  };

  const exportMask = () => {
    const out = document.createElement("canvas");
    out.width = size.w;
    out.height = size.h;
    const ctx = out.getContext("2d")!;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, size.w, size.h);
    // Any painted alpha becomes FULL white: a feathered latent mask at
    // sprite scale just smears the seam the composite would otherwise hide.
    const m = maskRef.current!.getContext("2d")!.getImageData(0, 0, size.w, size.h);
    const o = ctx.getImageData(0, 0, size.w, size.h);
    for (let i = 0; i < m.data.length; i += 4) {
      if (m.data[i + 3] > 32) {
        o.data[i] = o.data[i + 1] = o.data[i + 2] = 255;
      }
    }
    ctx.putImageData(o, 0, 0);
    onDone(out.toDataURL("image/png"));
  };

  if (!size.w) return null;
  return (
    <div
      style={{
        position: "fixed", inset: 0, background: "rgba(4,4,8,0.85)", zIndex: 40,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      <div style={{ ...S.card, marginBottom: 0, maxWidth: 720 }}>
        <h2 style={S.cardTitle}>brush the region to regenerate</h2>
        <div
          ref={wrapRef}
          style={{ position: "relative", width: size.w * size.scale, height: size.h * size.scale, ...S.checker }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={imageB64}
            alt="init"
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", imageRendering: "pixelated" }}
          />
          <canvas
            ref={maskRef}
            width={size.w}
            height={size.h}
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", cursor: "crosshair", touchAction: "none" }}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              drawing.current = true;
              const p = toCanvas(e);
              last.current = p;
              stroke(p, p);
            }}
            onPointerMove={(e) => {
              if (!drawing.current) return;
              const p = toCanvas(e);
              if (last.current) stroke(last.current, p);
              last.current = p;
            }}
            onPointerUp={() => {
              drawing.current = false;
              last.current = null;
            }}
          />
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 10, flexWrap: "wrap" }}>
          <label style={S.note}>
            brush {brush}px{" "}
            <input type="range" min={8} max={160} value={brush} onChange={(e) => setBrush(+e.target.value)} />
          </label>
          <button style={{ ...S.btn, ...(erase ? S.btnGreen : {}) }} onClick={() => setErase(!erase)}>
            {erase ? "erasing" : "erase"}
          </button>
          <button
            style={S.btn}
            onClick={() => {
              maskRef.current!.getContext("2d")!.clearRect(0, 0, size.w, size.h);
              setPainted(false);
            }}
          >
            clear
          </button>
          <span style={{ flex: 1 }} />
          <button style={{ ...S.btn, ...S.btnGhost }} onClick={onCancel}>
            cancel
          </button>
          <button style={{ ...S.btn, ...S.btnGreen }} disabled={!painted} onClick={exportMask}>
            use this mask
          </button>
        </div>
      </div>
    </div>
  );
}
