"use client";

/**
 * The workspace: images in, a task, a few honest fields, generate.
 *
 * Deliberately NOT a ComfyUI mirror. A mode is a task (rotate / animate /
 * in-between / edit / touch-up / pixelize); its fields come from the
 * server's mode registry, which also owns the prompts, the LoRA policy and
 * the coupled sampler bundles. The only tuning surface here is the
 * fast/quality toggle and an optional pinned seed — everything else that
 * LOOKS like a parameter is really a decision the registry already made.
 */
import React, { useEffect, useRef, useState } from "react";
import { S, AMBER, GREEN, fmtETA } from "./theme";
import type { Mode } from "./types";
import { fileToB64, urlToB64 } from "./api";
import { MaskEditor } from "./MaskEditor";

export type SlotId = "init" | "end" | "style";

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
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          width: 116, height: 116, borderRadius: 4, cursor: "pointer",
          border: `1px dashed ${drag ? "#8fdd9f" : "#2c303b"}`,
          ...(b64 ? {} : { background: "#0d0f14" }),
        }}
      >
        {b64 ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={b64} alt={label} style={{ width: 112, height: 112, objectFit: "contain", background: "#fff", borderRadius: 3, imageRendering: "pixelated" }} />
        ) : (
          <span style={{ ...S.note, padding: 6, textAlign: "center" }}>
            {label}
            <br />
            <span style={{ ...S.btn, display: "inline-block", marginTop: 6, pointerEvents: "none" }}>browse…</span>
            <br />
            <span style={{ fontSize: 11 }}>{hint ?? "or drop an image here"}</span>
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
      <div style={{ marginTop: 3, minHeight: 18 }}>
        <span style={S.note}>{label}</span>
        {b64 && (
          <button style={{ ...S.btn, ...S.btnGhost, fontSize: 10, padding: "0 5px", marginLeft: 6 }} onClick={onClear}>
            ×
          </button>
        )}
      </div>
    </div>
  );
}

export function GenerateCard({
  modes,
  reachable,
  images,
  setImage,
  mask,
  setMask,
  modeRequest,
  onLaunch,
  say,
}: {
  modes: Mode[];
  reachable: boolean;
  images: Record<SlotId, string | null>;
  setImage: (slot: SlotId, b64: string | null) => void;
  mask: string | null;
  setMask: (b64: string | null) => void;
  modeRequest: { id: string; params?: Record<string, string>; n: number } | null;
  onLaunch: (body: Record<string, unknown>) => Promise<void>;
  say: (s: string) => void;
}) {
  const [modeId, setModeId] = useState("rotate");
  const [params, setParams] = useState<Record<string, string>>({});
  const [fast, setFast] = useState(true);
  const [seed, setSeed] = useState("");
  const [brushOpen, setBrushOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [shipped, setShipped] = useState<{ name: string; url: string }[]>([]);

  const mode = modes.find((m) => m.id === modeId) ?? modes[0];

  // Committed sheets double as one-click style refs: a generation that sees
  // the real palette lands nearer it before the crush's snap.
  useEffect(() => {
    fetch("/api/comfy/pipeline?list=sprites")
      .then((r) => r.json())
      .then((j) => setShipped(j.sprites ?? []))
      .catch(() => {});
  }, []);

  // Field defaults land when the SELECTED MODE changes — keyed by id, never
  // by object identity: the manifest poll replaces the modes array every few
  // seconds, and resetting on identity wiped whatever the user was typing.
  const initedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!mode || initedFor.current === mode.id) return;
    initedFor.current = mode.id;
    const next: Record<string, string> = {};
    for (const f of mode.fields) next[f.id] = f.default ?? "";
    setParams(next);
  }, [mode]);

  /**
   * Is the init a SHEET rather than a character?
   *
   * Feeding a finished keyframe row back in as the reference produces rows
   * of four frogs each — the model reasonably reads "the character" as
   * everything in the picture. A sheet is much wider than tall; a standing
   * character is not. Advisory only: some creatures really are wide, and a
   * guard that blocks generation on a heuristic would be worse than the
   * mistake it prevents.
   */
  const [initAspect, setInitAspect] = useState(0);
  useEffect(() => {
    if (!images.init) return setInitAspect(0);
    const im = new Image();
    im.onload = () => setInitAspect(im.width / Math.max(1, im.height));
    im.src = images.init;
  }, [images.init]);
  const initLooksLikeSheet = initAspect > 1.6;

  // A frame action elsewhere (→ last, ✎ fix, ↻ pose) steers this card:
  // switch mode and, once its defaults have landed, lay the requested
  // params (e.g. the pose text) on top.
  const handledReq = useRef(0);
  useEffect(() => {
    if (!modeRequest || handledReq.current === modeRequest.n) return;
    handledReq.current = modeRequest.n;
    setModeId(modeRequest.id);
    if (modeRequest.params) {
      const merge = modeRequest.params;
      // Defaults for a newly-selected mode apply in the effect above on the
      // next render; queue the merge behind them.
      setTimeout(() => setParams((p) => ({ ...p, ...merge })), 0);
    }
  }, [modeRequest]);

  if (!mode) return null;
  const useFast = fast && mode.fastAvailable;
  const eta = fmtETA(mode.etaS[useFast ? "fast" : "quality"]);

  const setField = (id: string, v: string) => {
    const next = { ...params, [id]: v };
    // preset → refresh the prefilled action text so editing starts honest
    const preset = mode.presets?.find((p) => p.id === v);
    if (preset) {
      for (const f of mode.fields) if (f.prefillFrom === id) next[f.id] = preset.action;
    }
    setParams(next);
  };

  const missing: string[] = [];
  if (mode.needs.init && !images.init) missing.push("an init frame");
  if (mode.needs.end && !images.end) missing.push("a last frame");
  if (mode.needs.mask && !mask) missing.push("a brushed mask");
  for (const f of mode.fields) if (f.required && !params[f.id]) missing.push(f.label);

  const launch = async (batch?: string) => {
    if (missing.length) return say(`still needed: ${missing.join(", ")}`);
    setBusy(true);
    try {
      await onLaunch({
        mode: mode.id,
        params,
        imageB64: images.init,
        endB64: images.end ?? undefined,
        styleB64: images.style ?? undefined,
        maskB64: mode.needs.mask ? mask : undefined,
        fast: useFast,
        seed: seed.trim() === "" ? undefined : +seed,
        batch,
      });
    } catch (e: any) {
      say(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={S.card}>
      <h2 style={S.cardTitle}>generate</h2>
      {!reachable && <p style={S.note}>server is down — start it in the backend tab first</p>}
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
        <div>
          <ImageSlot label="init frame" b64={images.init} onSet={(b) => { setImage("init", b); setMask(null); }} onClear={() => { setImage("init", null); setMask(null); }} />
          {initLooksLikeSheet && (
            <p style={{ ...S.note, color: AMBER.fg, maxWidth: 150, marginTop: 4 }}>
              ⚠ this looks like a SHEET, not one character — cut it first and use a single cell, or every pose will
              come back as a row of copies
            </p>
          )}
        </div>
        {mode.needs.end && (
          <ImageSlot label="last frame" b64={images.end} hint="where the motion ends" onSet={(b) => setImage("end", b)} onClear={() => setImage("end", null)} />
        )}
        {mode.needs.style && (
          <div>
            <ImageSlot label="style ref" b64={images.style} hint="optional — a committed sheet" onSet={(b) => setImage("style", b)} onClear={() => setImage("style", null)} />
            {shipped.length > 0 && (
              <div style={{ display: "flex", gap: 3, flexWrap: "wrap", marginTop: 4, maxWidth: 116 }}>
                {shipped.slice(0, 8).map((s) => (
                  <button
                    key={s.name}
                    title={`use ${s.name} as the style ref`}
                    style={{ padding: 0, border: "1px solid #23262f", borderRadius: 3, background: "#fff", cursor: "pointer" }}
                    onClick={async () => setImage("style", await urlToB64(s.url))}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={s.url} alt={s.name} style={{ width: 24, height: 24, objectFit: "cover", display: "block" }} />
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <div style={{ flex: 1, minWidth: 340 }}>
          <div style={{ display: "flex", gap: 6, marginBottom: 4, flexWrap: "wrap" }}>
            {modes.map((m) => (
              <button
                key={m.id}
                style={{ ...S.btn, ...(m.id === modeId ? S.btnGreen : {}) }}
                title={m.blurb}
                onClick={() => setModeId(m.id)}
              >
                {m.title}
              </button>
            ))}
          </div>
          <p style={S.note}>{mode.blurb}</p>
          {mode.fields.map((f) => {
            if (f.showIf && Object.entries(f.showIf).some(([k, v]) => params[k] !== v)) return null;
            return (
              <label key={f.id} style={{ display: "block", marginTop: 8 }}>
                <div style={S.note}>{f.label}</div>
                {f.type === "select" ? (
                  <select style={S.input} value={params[f.id] ?? ""} onChange={(e) => setField(f.id, e.target.value)}>
                    {(f.options ?? []).map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    style={S.input}
                    value={params[f.id] ?? ""}
                    placeholder={f.placeholder}
                    onChange={(e) => setField(f.id, e.target.value)}
                  />
                )}
              </label>
            );
          })}
          {mode.needs.mask && (
            <div style={{ marginTop: 8 }}>
              <button
                style={{ ...S.btn, ...(mask ? {} : S.btnGreen) }}
                disabled={!images.init}
                title={images.init ? "" : "pick an init frame first"}
                onClick={() => setBrushOpen(true)}
              >
                {mask ? "re-brush mask" : "brush the region…"}
              </button>
              {mask && <span style={S.chip(GREEN.fg, GREEN.bg)}>mask ready</span>}
            </div>
          )}
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12, flexWrap: "wrap" }}>
            <button style={{ ...S.btn, ...S.btnGreen }} disabled={!reachable || busy} onClick={() => launch()}>
              {busy ? "queueing…" : `generate (${eta})`}
            </button>
            {mode.batch && (
              <button style={S.btn} disabled={!reachable || busy} title="queues one job per facing" onClick={() => launch(mode.batch!.id)}>
                {mode.batch.label}
              </button>
            )}
            <label title={mode.fastAvailable ? "Lightning distill — same model, ~3x faster, slightly softer" : "download the Lightning LoRA in the backend tab to enable"}>
              <input type="checkbox" checked={useFast} disabled={!mode.fastAvailable} onChange={(e) => setFast(e.target.checked)} /> fast
            </label>
            <input
              style={{ ...S.input, width: 110 }}
              value={seed}
              placeholder="seed (random)"
              title="pin a seed to make re-runs comparable; blank rolls fresh"
              onChange={(e) => setSeed(e.target.value.replace(/[^\d]/g, ""))}
            />
          </div>
          {mode.notes.length > 0 && (
            <p style={S.note}>
              {mode.notes.map((n) => (
                <span key={n} style={{ ...S.chip(AMBER.fg, AMBER.bg), marginLeft: 0, marginRight: 6 }}>
                  {n}
                </span>
              ))}
            </p>
          )}
        </div>
      </div>
      {brushOpen && images.init && (
        <MaskEditor
          imageB64={images.init}
          onDone={(m) => {
            setMask(m);
            setBrushOpen(false);
          }}
          onCancel={() => setBrushOpen(false)}
        />
      )}
    </div>
  );
}
