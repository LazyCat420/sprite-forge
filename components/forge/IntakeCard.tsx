"use client";

/**
 * INTAKE — drop any picture here, leave with a frame the rest of the road can use.
 *
 * The checkpoint is the whole design. Every later stage inherits this frame's
 * framing, scale and identity, so a bad one is not a bad frame — it is six
 * wasted sheets whose cause will not be obvious by then. So intake runs a stage,
 * STOPS, and shows what it measured.
 *
 * Fixes are offered in COST ORDER, which is why the geometry ones exist at all:
 * re-centre, re-scale and strip-the-shelf are pipeline ops with no GPU, so they
 * are instant and can be tried repeatedly. Only the cut-out (~10s) and the style
 * pass (~2min) spend model time.
 */
import React, { useState } from "react";
import { S, GREEN, AMBER, RED, GREY, BLUE } from "./theme";
import { fileToB64, postJSON } from "./api";
import type { Mode } from "./types";

type Verdict = {
  level: "ready" | "usable" | "reject";
  checks: { id: string; label: string; value: string; want: string; pass: boolean; soft?: boolean; why?: string; fix?: string }[];
  report: string;
};

const LEVEL = { ready: GREEN, usable: AMBER, reject: RED } as const;

export function IntakeCard({
  modes,
  reachable,
  say,
  onLaunch,
  onUseAsInit,
  segJobFrame,
}: {
  modes: Mode[];
  reachable: boolean;
  say: (s: string) => void;
  /** Fire a GPU mode and resolve with its first output frame as a data URL. */
  onLaunch: (body: Record<string, unknown>) => Promise<string | null>;
  /** Hand the finished idle frame to the generate tab. */
  onUseAsInit: (b64: string) => void;
  segJobFrame?: string;
}) {
  const [source, setSource] = useState<string | null>(null);
  const [frame, setFrame] = useState<string | null>(null);
  const [sourceH, setSourceH] = useState<number | undefined>();
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [styled, setStyled] = useState(false);

  const hasSegment = modes.some((m) => m.id === "segment");

  const qa = async (b64: string, afterStyle = false, sh?: number) => {
    const v = await postJSON("/api/comfy/pipeline", {
      op: "qa",
      frameB64: b64,
      sourceH: sh ?? sourceH,
      afterStyle,
    });
    setVerdict(v);
    return v as Verdict;
  };

  const reframe = async (opts: Record<string, unknown> = {}) => {
    if (!frame) return;
    setBusy("reframe");
    try {
      const r = await postJSON("/api/comfy/pipeline", { op: "reframe", frameB64: frame, ...opts });
      const next = "data:image/png;base64," + r.frameB64;
      setFrame(next);
      setSourceH(r.sourceH);
      setNotes(r.notes ?? []);
      await qa(next, styled, r.sourceH);
    } catch (e: any) {
      say(e.message);
    } finally {
      setBusy(null);
    }
  };

  const pick = async (f: File) => {
    setBusy("prep");
    setVerdict(null);
    setStyled(false);
    setNotes([]);
    try {
      const raw = await fileToB64(f);
      setSource(raw);
      const p = await postJSON("/api/comfy/pipeline", { op: "prep", imageB64: raw });
      const next = "data:image/png;base64," + p.frameB64;
      setFrame(next);
      // Judge the raw thing too — it is usually a reject, and seeing WHY is
      // what teaches the next upload.
      await qa(next);
    } catch (e: any) {
      say(e.message);
    } finally {
      setBusy(null);
    }
  };

  const cutOut = async () => {
    if (!frame) return;
    setBusy("segment");
    try {
      const out = await onLaunch({ mode: "segment", imageB64: frame });
      if (!out) return say("the cut-out produced nothing");
      // Straight into the reframe: a cut-out alone is not yet a usable frame.
      const r = await postJSON("/api/comfy/pipeline", { op: "reframe", frameB64: out, stripShelf: true });
      const next = "data:image/png;base64," + r.frameB64;
      setFrame(next);
      setSourceH(r.sourceH);
      setNotes(r.notes ?? []);
      await qa(next, false, r.sourceH);
    } catch (e: any) {
      say(e.message);
    } finally {
      setBusy(null);
    }
  };

  const stylePass = async () => {
    if (!frame) return;
    setBusy("style");
    try {
      const out = await onLaunch({ mode: "intake-style", imageB64: frame, fast: true });
      if (!out) return say("the style pass produced nothing");
      // RE-KEY AND RE-REGISTER. Qwen returns an opaque frame with the character
      // no longer on the feet line; without this the contract quietly breaks.
      const r = await postJSON("/api/comfy/pipeline", { op: "reframe", frameB64: out, stripShelf: true });
      const next = "data:image/png;base64," + r.frameB64;
      setFrame(next);
      setSourceH(r.sourceH);
      setNotes(r.notes ?? []);
      setStyled(true);
      await qa(next, true, r.sourceH);
    } catch (e: any) {
      say(e.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={S.card}>
      <h2 style={S.cardTitle}>
        intake
        <span style={S.chip(GREY.fg, GREY.bg)}>any picture → one clean idle frame</span>
        {!hasSegment && <span style={S.chip(AMBER.fg, AMBER.bg)}>cut-out model not installed</span>}
      </h2>
      <p style={S.note}>
        A photo, a render, a drawing, a screenshot. The cut-out lifts the subject off whatever is behind it; the reframe
        puts it at the size and baseline the game registers against. Nothing downstream can fix a bad frame here — that
        is what the checks are for.
      </p>

      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 10, alignItems: "flex-start" }}>
        <label style={{ ...S.btn, display: "inline-block", cursor: "pointer" }}>
          {busy === "prep" ? "reading…" : source ? "pick another image…" : "pick an image…"}
          <input
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            onChange={(e) => e.target.files?.[0] && pick(e.target.files[0])}
          />
        </label>
        {frame && (
          <>
            <button
              style={{ ...S.btn, ...S.btnGreen }}
              disabled={busy !== null || !reachable || !hasSegment}
              title={hasSegment ? "lift the subject off its background (~10s)" : "install a background-removal model in the backend tab"}
              onClick={cutOut}
            >
              {busy === "segment" ? "cutting out…" : "✂ cut out the subject"}
            </button>
            <button style={S.btn} disabled={busy !== null} onClick={() => reframe({ stripShelf: true })}>
              {busy === "reframe" ? "reframing…" : "re-frame"}
            </button>
            <button style={S.btn} disabled={busy !== null} title="keep only the largest piece" onClick={() => reframe({ keepExtras: false })}>
              drop extra pieces
            </button>
            <button
              style={{ ...S.btn, ...S.btnGreen }}
              disabled={busy !== null || !reachable}
              title="turn it into pixel art — framing is already fixed, so this only changes the look"
              onClick={stylePass}
            >
              {busy === "style" ? "styling… (~2min)" : "→ to pixel art"}
            </button>
          </>
        )}
      </div>

      {(source || frame) && (
        <div style={{ display: "flex", gap: 12, marginTop: 12, flexWrap: "wrap" }}>
          {source && (
            <figure style={{ margin: 0 }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={source} alt="source" style={{ width: 150, borderRadius: 4, background: "#fff" }} />
              <figcaption style={S.note}>what you gave it</figcaption>
            </figure>
          )}
          {frame && (
            <figure style={{ margin: 0 }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={frame}
                alt="intake frame"
                style={{ width: 220, borderRadius: 4, ...S.checker, imageRendering: "pixelated" }}
              />
              <figcaption style={S.note}>{styled ? "styled + re-registered" : "current frame"}</figcaption>
            </figure>
          )}
        </div>
      )}

      {notes.map((n, i) => (
        <p key={i} style={{ ...S.note, color: AMBER.fg }}>
          · {n}
        </p>
      ))}

      {verdict && (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={S.chip(LEVEL[verdict.level].fg, LEVEL[verdict.level].bg)}>{verdict.level}</span>
            <span style={S.note}>
              {verdict.level === "ready"
                ? "every check passed"
                : verdict.level === "usable"
                  ? "it will work, at the cost below — your call"
                  : "something downstream provably breaks"}
            </span>
            <span style={{ flex: 1 }} />
            <button
              style={{ ...S.btn, ...(verdict.level === "reject" ? {} : S.btnGreen) }}
              disabled={verdict.level === "reject" || !frame}
              title={verdict.level === "reject" ? "fix the failing checks first" : "hand this to the keyframe generator"}
              onClick={() => frame && onUseAsInit(frame)}
            >
              use as the character →
            </button>
          </div>
          <div style={{ marginTop: 8 }}>
            {verdict.checks.map((c) => (
              <div key={c.id} style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap", padding: "2px 0" }}>
                <span style={{ width: 16, color: c.pass ? GREEN.fg : c.soft ? AMBER.fg : RED.fg }}>
                  {c.pass ? "ok" : c.soft ? "~" : "✖"}
                </span>
                <span style={{ minWidth: 210, color: c.pass ? "#8a90a0" : "#e8e6df" }}>{c.label}</span>
                <span style={{ ...S.note, minWidth: 200 }}>{c.value}</span>
                {!c.pass && <span style={{ ...S.note, color: BLUE.fg }}>{c.want}</span>}
                {!c.pass && c.why && <span style={{ ...S.note, flexBasis: "100%", paddingLeft: 24 }}>{c.why}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
