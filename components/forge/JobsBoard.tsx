"use client";

/**
 * Every generation this dev server knows about, newest first — live ones
 * with a progress bar and a cancel, finished ones with their frames and
 * the three actions that make iteration cheap:
 *
 *   ↻ re-roll        same job, new seed — for "right idea, wrong roll"
 *   → use as init    chain the output into the next generation (the
 *                    continuity move: each frame builds on the last)
 *   + add to sheet   pull frames into the tray under a clip name
 *
 * Job state comes from polling the generate route; the live preview image
 * is refetched only while the server says one exists.
 */
import React, { useEffect, useState } from "react";
import { S, GREEN, RED, BLUE, AMBER, GREY } from "./theme";
import type { Job, Mode, Progress } from "./types";
import { CLIP_NAMES } from "./types";

/**
 * Sampler percentage, or null when there is nothing honest to show.
 *
 * ── WHY THIS IS A FUNCTION AND NOT TWO INLINE TERNARIES ─────────────────────
 *
 * `watchProgress` multiplexes two different events onto one field. A sampler
 * step arrives as {value: k, max: steps}; a NODE CHANGE arrives as
 * {value: 0, max: 1}, meaning "started executing node `uh`" — the high-noise
 * unet loader — not "0% of the way through sampling".
 *
 * So `max > 1` is the test for "this is real progress". `max` alone accepts a
 * node change and pins the bar at 0% for the ~90 seconds a Wan model load
 * takes, which reads as a hung job. That is the exact failure the live banner
 * was added to rule out, and the banner shipped with the bug: JobCard had the
 * correct guard, the banner was written three hundred lines below it with a
 * plain truthiness check, and nothing connected them. Verified against a live
 * run — the first heartbeat of every Wan job is {node: "uh", value: 0, max: 1}.
 *
 * One function, two call sites, one behaviour. `progress-pct.test.ts` pins it.
 */
export function samplerPct(progress: Progress | undefined): number | null {
  if (!progress || !(progress.max > 1)) return null;
  return Math.round((progress.value / progress.max) * 100);
}

/**
 * Seconds a job has been running, from the WALL CLOCK.
 *
 * ── `tick` IS NOT A CLOCK ───────────────────────────────────────────────────
 *
 * `ForgePanel` holds `const [tick, setTick] = useState(0)` — a counter that
 * exists to bust the preview image cache (`&t=${tick}`) and to force this
 * board to re-render on each poll. It is passed down as a prop, it sits in
 * scope, and it is named like a time. It is not one.
 *
 * The live banner computed `tick - startedAt`, which is a small integer minus
 * a millisecond epoch: hugely negative, clamped by `Math.max(0, …)`, and
 * therefore **permanently 0m00s**. Caught only by screenshotting the page —
 * the banner read `0m00s` directly above a JobCard reading `81s` for the same
 * job. The API check that "verified" the fix could not see it, because the
 * bug was in the arithmetic, not the data.
 *
 * Third time in this one file that a helper was reimplemented from scratch
 * beside a correct copy and got it wrong (see `samplerPct`). Hence a function.
 * `tick` still drives the re-render; it just no longer pretends to be the time.
 */
export function elapsedSecs(startedAt: number | undefined, now: number = Date.now()): number | null {
  if (!startedAt) return null;
  return Math.max(0, Math.round((now - startedAt) / 1000));
}

/** `123` -> `2m03s`. */
export function formatElapsed(secs: number | null): string | null {
  if (secs === null) return null;
  return `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, "0")}s`;
}

/**
 * Trigger words that a mode prepends only when its LoRA is installed.
 *
 * Listed here so an edited prompt can warn about deleting one. A LoRA that is
 * loaded but never triggered is the quietest possible failure — the graph is
 * correct, the run succeeds, the adapter simply does nothing to the picture,
 * and the only evidence is that the art looks like the base model.
 *
 * This is a UI hint, not a gate: `modes.mjs` decides what actually gets
 * prepended, and a word missing from this list costs a warning, not a run.
 */
const LORA_TRIGGERS = ["pix3lwalk"];

/**
 * The facings "all angles" adds, given a clip that already exists facing right.
 *
 * E is deliberately absent: the master is authored facing right (the `create`
 * prompt says "side view facing right") and the first clip IS the E clip, so
 * re-rotating to E would spend a generation turning a figure to where it
 * already points — and every hop through Qwen-Image-Edit costs identity.
 */
const OTHER_FACINGS = ["S", "N"];
import { FramePlayer } from "./FramePlayer";
import { RetryImg } from "./RetryImg";
import { postJSON, urlToB64 } from "./api";

/**
 * Cut a keyframe sheet into per-pose cells, client-side: the pipeline's
 * cut op finds the rects (the REAL slicer — same failure modes, same
 * fixes), the browser crops them onto white. Returned as data URLs so
 * every existing frame action (→ init, fetch, + sheet) works unchanged —
 * fetch() accepts data: URLs.
 *
 * ── EVERY CELL COMES OUT ON THE SAME CANVAS, AND THAT IS THE POINT ──────
 * A pose's bounding box is its own size (measured: 321×365, 267×437,
 * 288×410, 264×432 for one walk row). Cropped tight, each cell is a
 * different aspect ratio — and the first/last-frame video node stretches
 * whatever it is given to ONE square, so two tight crops arrive at two
 * different scales and the model dutifully interpolates between them.
 * That reads as a slow zoom-in across the clip, which is exactly what it
 * looked like.
 *
 * So cells are placed, never rescaled: one canvas sized to the widest and
 * tallest cell, figure centred horizontally, FEET ON A SHARED BASELINE —
 * the same registration rule the sprite importer uses (see the forge
 * README on scale and baselines). Identical canvas, identical scale, no
 * zoom for the model to invent.
 */
async function cutSheetToCells(frameSrc: string, clip: string): Promise<string[]> {
  const b64 = await urlToB64(frameSrc);
  const cut = await postJSON("/api/comfy/pipeline", { op: "cut", sheetB64: b64, sidecar: { rows: [clip || "idle"] } });
  const rects: number[][] = (cut.rows ?? []).flatMap((r: { cells: number[][] }) => r.cells);
  if (!rects.length) throw new Error(`cut found no cells${cut.warnings?.length ? ` — ${cut.warnings[0]}` : ""}`);
  const img = new Image();
  await new Promise<void>((res, rej) => {
    img.onload = () => res();
    // An <img> error event is NOT an Error — rejecting with it raw is what
    // made this failure surface as the word "undefined".
    img.onerror = () => rej(new Error("the sheet did not decode in the browser"));
    // urlToB64 hands back a COMPLETE data: URL (FileReader.readAsDataURL),
    // so prefixing it again built "data:…;base64,data:…" and every cut died
    // on an unparseable image.
    img.src = b64.startsWith("data:") ? b64 : `data:image/png;base64,${b64}`;
  });
  // HEADROOM, proportional. Even with the scales matched, the video leg
  // grows the figure ~11% across a clip (measured), and a fixed 24px
  // margin let that growth crop the head. Margins scale with the figure:
  // generous above (growth reads as a push-in, so the head goes first),
  // wide enough at the sides for a full stride, tight under the feet so
  // the baseline stays where the importer expects it.
  const maxW = Math.max(...rects.map(([x0, , x1]) => x1 - x0));
  const maxH = Math.max(...rects.map(([, y0, , y1]) => y1 - y0));
  const padX = Math.ceil(maxW * 0.18);
  const padTop = Math.ceil(maxH * 0.2);
  const padBottom = Math.ceil(maxH * 0.06);
  const cw = maxW + padX * 2;
  const ch = maxH + padTop + padBottom;
  return rects.map(([x0, y0, x1, y1]) => {
    const w = x1 - x0;
    const h = y1 - y0;
    const cv = document.createElement("canvas");
    cv.width = cw;
    cv.height = ch;
    const ctx = cv.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, cw, ch);
    // 1:1 blit — centred, bottom-aligned to the shared baseline.
    ctx.drawImage(img, x0, y0, w, h, Math.round((cw - w) / 2), ch - padBottom - h, w, h);
    return cv.toDataURL("image/png");
  });
}

/** Pose text for cell i, recovered from the job's own resolved prompt. */
function poseLine(job: Job, i: number): string {
  const m = /left to right: (.*?)\. Large/.exec(job.resolvedPrompt ?? "");
  if (!m) return "";
  const parts = m[1].split(/\(\d\)\s*/).filter((s) => s.trim());
  return (parts[i] ?? "").replace(/,\s*$/, "").trim();
}

const STATE_COLOR: Record<Job["state"], { fg: string; bg: string }> = {
  queued: GREY,
  running: BLUE,
  done: GREEN,
  error: RED,
  cancelled: GREY,
};

/**
 * Which clip this job's frames belong to — or "" when nothing on the job says.
 *
 * ⚠️ THIS USED TO GUESS, AND THE GUESS WAS ALWAYS `walk`. An `animate` job
 * whose preset is `custom` carries clip "" by design (MOVESET's custom entry
 * declares no clip), and the old fallback turned that into `walk`. So a
 * custom-action death clip — a creature toppling over and lying still — came
 * up labelled "walk", and the label is not cosmetic: it is what the frames get
 * added to the sheet tray AS. A wrong row in the tray becomes a wrong row in
 * the sidecar becomes a wrong clip in the game.
 *
 * "" is the honest answer, and `` renders it as an explicit "— pick a clip —"
 * that blocks the add buttons until the operator chooses. A prompt is better
 * than a plausible guess, because the guess is invisible once it is wrong.
 */
function clipGuess(job: Job): string {
  // The preset's declared clip travels on the job (defend → crouch etc.);
  // reading the preset id is the fallback for pre-clip jobs already on disk.
  if (job.clip && (CLIP_NAMES as readonly string[]).includes(job.clip)) return job.clip;
  const p = String(job.params?.preset ?? "");
  if ((CLIP_NAMES as readonly string[]).includes(p)) return p;
  // A single-frame qwen leg (rotate/edit/cut-out) really is an idle pose —
  // that is what a master IS — so it keeps a default. Everything else asks.
  return job.mode === "animate" ? "" : "idle";
}

function JobCard({
  id,
  job,
  tick,
  mode,
  onCancel,
  onReroll,
  onUseAsInit,
  onUseAsLast,
  onFixFrame,
  onRedoPose,
  onAddToTray,
  onKeep,
  onAllAngles,
}: {
  id: string;
  job: Job;
  tick: number;
  /** This job's mode from the registry — carries the move presets. */
  mode?: Mode;
  onCancel: (id: string) => void;
  onReroll: (id: string, job: Job, edits?: { params?: Record<string, string>; prompt?: string; negative?: string }) => void | Promise<void>;
  onUseAsInit: (src: string) => void;
  onUseAsLast: (src: string) => void;
  onFixFrame: (src: string) => void;
  onRedoPose: (src: string, pose: string) => void;
  onAddToTray: (srcs: string[], clip: string) => void;
  onKeep: (id: string, job: Job) => void;
  /** Absent when the panel does not offer the chain (keeps the button off). */
  onAllAngles?: (id: string, job: Job, facings: string[]) => void | Promise<void>;
}) {
  const [clip, setClip] = useState(clipGuess(job));
  /** Only true when someone asks to relabel a clip the preset already decided. */
  const [editClip, setEditClip] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);

  /**
   * ── WHY THIS CARD LAUNCHES WORK AND NOT JUST REPEATS IT ────────────────────
   *
   * The only action here used to be "↻ re-roll", which is same-params-new-seed.
   * So there was no way to say "now do the RUN clip" from a finished walk, and
   * the nearest-looking control was the `as clip` dropdown — which does not
   * generate anything, it labels where frames get FILED. Setting it to `run` on
   * a walk card files walk frames as the run clip, silently, and the sheet then
   * plays a walk whenever the creature runs.
   *
   * So: the move lives here, next to the button, and the button says which of
   * the two things it is about to do.
   */
  const moves = mode?.presets ?? null;
  const startMove = typeof job.params?.preset === "string" ? job.params.preset : "";
  const [move, setMove] = useState(startMove);
  /**
   * `null` means UNEDITED — let the mode write the prompt.
   *
   * Not `""` and not a copy of `resolvedPrompt`: a copy cannot be told apart
   * from a deliberate edit that happens to match, and an empty string reads as
   * "the user cleared it". Only `null` says "nobody has touched this", which is
   * what decides whether the button is a run or a re-roll and whether the
   * server gets an override at all.
   */
  const [prompt, setPrompt] = useState<string | null>(null);
  /**
   * What the CURRENTLY SELECTED move resolves to, before any edit.
   *
   * Not `job.resolvedPrompt` — that is the prompt of the move this card already
   * ran. Pick `run` on a finished walk card and the box must show the run
   * prompt, or you edit one move's words believing they belong to another.
   * Fetched from the registry rather than templated here; see `?resolve=`.
   */
  const [basePrompt, setBasePrompt] = useState(job.resolvedPrompt ?? "");
  /** Same story for the negative — see `resolvedNegative` on the Job type. */
  const [baseNegative, setBaseNegative] = useState(job.resolvedNegative ?? "");
  const [negative, setNegative] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [busy, setBusy] = useState(false);
  const negativeText = negative ?? baseNegative;
  const promptText = prompt ?? basePrompt;

  /**
   * "RE-ROLL" IS ONLY HONEST WHEN NOTHING CHANGED.
   *
   * A re-roll is the same settings with a new seed — a second opinion on work
   * already done. The moment the move or the prompt is edited this is a FIRST
   * render of something that has never existed, and calling that a re-roll
   * invites the reading that the clip already exists somewhere.
   */
  const moveChanged = move !== startMove;
  const promptChanged = prompt !== null && prompt.trim() !== basePrompt.trim();
  const negativeChanged = negative !== null && negative.trim() !== baseNegative.trim();
  const isRerun = moveChanged || promptChanged || negativeChanged;
  const moveLabel = moves?.find((p) => p.id === move)?.label ?? move;

  // Ask the registry what the selected move says. Skipped for the move this
  // card already ran — its prompt is on the job record and is the exact string
  // that produced these frames, which a re-resolve could only approximate if
  // an option has been installed or removed since.
  useEffect(() => {
    if (!moveChanged) {
      setBasePrompt(job.resolvedPrompt ?? "");
      setBaseNegative(job.resolvedNegative ?? "");
      return;
    }
    let live = true;
    setResolving(true);
    const params = JSON.stringify({ ...(job.params ?? {}), preset: move });
    fetch(`/api/comfy/generate?resolve=${encodeURIComponent(job.mode)}&params=${encodeURIComponent(params)}`)
      .then((r) => r.json())
      .then((d) => {
        if (!live) return;
        if (typeof d.prompt === "string") setBasePrompt(d.prompt);
        if (typeof d.negative === "string") setBaseNegative(d.negative);
      })
      .catch(() => {
        /* the button still works — the server resolves it again at launch */
      })
      .finally(() => {
        if (live) setResolving(false);
      });
    return () => {
      live = false;
    };
  }, [move, moveChanged, job.mode, job.params, job.resolvedPrompt, job.resolvedNegative]);
  /**
   * THE GUARD LIVES HERE, not on the buttons.
   *
   * Four different controls add frames to the tray — "add all", the frame
   * player's selection, the per-frame "+ sheet", and each cut cell. Disabling
   * one of them would leave three doors open, and the whole point is that an
   * unlabelled clip must not reach the tray at all.
   */
  const addToTray = (srcs: string[]) => {
    if (!clip) return;
    onAddToTray(srcs, clip);
  };
  /** Every add control wears the same reason when the clip is unset. */
  const addProps = clip
    ? {}
    : { disabled: true, title: "pick which clip these frames are — the tray files them under it" };
  const dimmed = clip ? {} : { opacity: 0.45, cursor: "not-allowed" };
  const [cells, setCells] = useState<string[] | null>(null);
  const [cutting, setCutting] = useState<string | null>(null);
  const c = STATE_COLOR[job.state] ?? GREY;
  const frames = (job.frames ?? []).map((f) => ({ name: f, src: `/api/comfy/generate?id=${id}&frame=${f}` }));
  /**
   * Frames whose limbs dissolved in the decode. Every add path filters against
   * this set for the same reason the clip guard lives on `addToTray` and not on
   * the buttons: there are four doors into the tray and a bad frame only has to
   * find one of them.
   */
  const ghostFlagged = new Set(job.ghost?.flagged ?? []);
  const elapsed = elapsedSecs(job.startedAt);
  const pct = samplerPct(job.progress);

  return (
    <div style={{ background: "#0d0f14", borderRadius: 4, padding: "10px 12px", marginTop: 8 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span style={{ color: "#e8e6df" }}>{job.label ?? job.mode}</span>
        <span style={S.chip(c.fg, c.bg)}>{job.state === "queued" ? `queued · waiting for ${job.leg ?? "gpu"}` : job.state}</span>
        {job.character && <span style={S.chip(AMBER.fg, AMBER.bg)}>{job.character}</span>}
        {job.fast && <span style={S.chip(AMBER.fg, AMBER.bg)}>fast</span>}
        {job.seed !== undefined && <span style={S.note}>seed {job.seed}</span>}
        {job.state === "running" && elapsed !== null && <span style={S.note}>{elapsed}s</span>}
        {job.state === "done" && job.tookS !== undefined && <span style={S.note}>{job.tookS}s</span>}
        <span style={{ flex: 1 }} />
        {job.resolvedPrompt && (
          <button style={{ ...S.btn, ...S.btnGhost }} onClick={() => setShowPrompt(!showPrompt)}>
            prompt
          </button>
        )}
        {(job.state === "running" || job.state === "queued") && (
          <button style={{ ...S.btn, ...S.btnDanger }} onClick={() => onCancel(id)}>
            cancel
          </button>
        )}
        {job.state !== "running" && job.state !== "queued" && job.params && moves && moves.length > 1 && (
          <select
            style={{ ...S.input, width: 150 }}
            value={move}
            title="which move to generate — NOT where the frames get filed"
            onChange={(e) => {
              setMove(e.target.value);
              // Back to unedited: an edit made for the last move would
              // otherwise ride along into a different one, which is how you get
              // a "run" clip whose prompt still says walk.
              setPrompt(null);
            }}
          >
            {moves.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        )}
        {job.state !== "running" && job.state !== "queued" && job.params && (
          <button
            // Launching uploads the init and queues a job — hundreds of ms at
            // best. Without a visible in-flight state the only feedback is a
            // toast that may land below the fold, which is how a working button
            // gets reported as doing nothing.
            disabled={busy}
            style={{ ...S.btn, ...(isRerun ? S.btnGreen : {}), ...(busy ? { opacity: 0.5, cursor: "wait" } : {}) }}
            title={
              isRerun
                ? `generate ${moveLabel || "this"}${promptChanged ? " with the edited prompt" : ""} — this has not been rendered yet`
                : "same settings, new seed — a second opinion on the clip above"
            }
            onClick={async () => {
              setBusy(true);
              try {
                await onReroll(
                  id,
                  job,
                  isRerun
                    ? {
                        params: { ...(job.params ?? {}), preset: move },
                        // Only send an override when the words were actually
                        // edited. A move change alone must let the registry
                        // write the prompt, not echo back a string this card
                        // resolved.
                        prompt: promptChanged ? promptText.trim() : undefined,
                        negative: negativeChanged ? negativeText.trim() : undefined,
                      }
                    : undefined,
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "queuing…" : isRerun ? `▶ run ${moveLabel}` : "↻ re-roll"}
          </button>
        )}
        {/* ── THE ANGLES, ONLY ONCE THIS ONE IS GOOD ──────────────────────
            A moveset is 18 Wan jobs. Generating one facing, looking at it, and
            only then paying for the rest is the order that lets a bad master be
            caught for the price of a single clip. So this is a button you press
            after the eye test, not a batch that runs ahead of it.

            Absent while any frame is flagged: every facing branches off this
            clip's init, so a dissolved limb in the source would be rotated into
            all of them. */}
        {job.state === "done" && job.mode === "animate" && (job.frames?.length ?? 0) > 0 && onAllAngles && (
          <button
            style={{ ...S.btn, ...(ghostFlagged.size ? { opacity: 0.45 } : {}) }}
            disabled={ghostFlagged.size > 0}
            title={
              ghostFlagged.size
                ? `${ghostFlagged.size} frame(s) here have a dissolved limb — fix this clip before spending GPU on the other facings`
                : "rotate this clip's master to S and N, then animate the same move in each — about 27 minutes"
            }
            onClick={() => onAllAngles(id, job, OTHER_FACINGS)}
          >
            ⟳ all angles
          </button>
        )}
        {job.state === "done" && (job.frames?.length ?? 0) > 0 && (
          <button
            style={S.btn}
            title="file these frames under the character's sources/ (tracked) — work/ is scratch"
            onClick={() => onKeep(id, job)}
          >
            ⭐ keep
          </button>
        )}
      </div>
      {showPrompt && (
        <div style={{ marginTop: 8 }}>
          <textarea
            style={{ ...S.input, width: "100%", minHeight: 92, fontFamily: "inherit", lineHeight: 1.45, resize: "vertical" }}
            value={promptText}
            spellCheck={false}
            placeholder={resolving ? "resolving…" : "the prompt this run will use"}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4, flexWrap: "wrap" }}>
            {promptChanged ? (
              <>
                <span style={S.chip(GREEN.fg, GREEN.bg)}>edited</span>
                <button style={{ ...S.btn, fontSize: 11 }} onClick={() => setPrompt(null)}>
                  revert to the preset
                </button>
              </>
            ) : (
              <span style={S.note}>written by the {moveLabel || job.mode} preset — edit it and the button becomes ▶ run</span>
            )}
            {/* The trigger word is prepended by the mode only when its LoRA is
                installed. Editing the prompt is the one way to delete it, and
                a LoRA that is loaded but never triggered is silent — it just
                quietly does nothing to the picture. */}
            {LORA_TRIGGERS.some((t) => basePrompt.includes(t) && !promptText.includes(t)) && (
              <span style={S.chip(AMBER.fg, AMBER.bg)} title="the LoRA is still loaded but will not fire without its trigger word">
                ⚠ trigger word removed
              </span>
            )}
          </div>

          {/* ── THE NEGATIVE ────────────────────────────────────────────────
              Half the prompt, and on the Wan leg the half doing the most work.
              It was never recorded, so "show me the prompt that made this" could
              only ever show the positive — while the clause that stops the feet
              gliding, the clause that stops the camera pushing in and the clause
              that stops the background going black all sat in here, invisible.
              Every one of them was added off a measured failure. */}
          <div style={{ marginTop: 10 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4, flexWrap: "wrap" }}>
              <span style={S.note}>negative — what it is told to avoid</span>
              {negativeChanged && <span style={S.chip(GREEN.fg, GREEN.bg)}>edited</span>}
              {negativeChanged && (
                <button style={{ ...S.btn, fontSize: 11 }} onClick={() => setNegative(null)}>
                  revert
                </button>
              )}
            </div>
            {baseNegative || negative !== null ? (
              <textarea
                style={{ ...S.input, width: "100%", minHeight: 72, fontFamily: "inherit", lineHeight: 1.45, resize: "vertical", color: "#a6adba" }}
                value={negativeText}
                spellCheck={false}
                onChange={(e) => setNegative(e.target.value)}
              />
            ) : (
              <p style={S.note}>
                not recorded — this job ran before the negative was written into job.json. Change the move or re-run and it
                will be there.
              </p>
            )}
          </div>
        </div>
      )}
      {job.state === "running" && (
        <div style={{ marginTop: 8, display: "flex", gap: 10, alignItems: "center" }}>
          {job.hasPreview && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`/api/comfy/generate?id=${id}&preview=1&t=${tick}`}
              alt="live preview"
              style={{ width: 96, height: 96, objectFit: "contain", background: "#fff", borderRadius: 4 }}
            />
          )}
          <div style={{ flex: 1 }}>
            <div style={{ height: 6, background: "#171921", borderRadius: 3, overflow: "hidden" }}>
              <div
                style={{
                  height: "100%",
                  width: pct !== null ? `${pct}%` : "18%",
                  background: BLUE.fg,
                  opacity: pct !== null ? 1 : 0.35,
                  transition: "width 0.5s",
                }}
              />
            </div>
            <p style={S.note}>
              {pct !== null ? `${pct}% — sampling` : "queued / loading models"}
              {job.progress?.node ? ` (${job.progress.node})` : ""}
            </p>
          </div>
        </div>
      )}
      {job.state === "error" && <p style={{ ...S.note, color: RED.fg, whiteSpace: "pre-wrap" }}>{job.error}</p>}
      {job.state === "done" && frames.length > 0 && (
        <>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
            {/* ── ONE CONTROL, NOT TWO ──────────────────────────────────────
                There used to be a `file as` dropdown here AND a move select in
                the header, and on an attack card both read "attack" — two
                controls, same word, different meanings. Worse, they invited the
                reading that this one generates: set it to `run` on a walk card
                and the sheet plays a walk whenever the creature runs, silently.

                But the clip is not a free choice. The preset that MADE these
                frames declares it (`walk4` → walk, `defend` → crouch), so it is
                derived, shown as a fact, and only offered as a dropdown in the
                one case where nothing on the job knows: a `custom` action. The
                pencil is there because a mislabelled old job should still be
                fixable without regenerating it. */}
            {clip && !editClip ? (
              <>
                <span style={S.note}>files as</span>
                <span style={S.chip(GREEN.fg, GREEN.bg)} title="from the preset that generated these frames">
                  {clip}
                </span>
                <button
                  style={{ ...S.btn, ...S.btnGhost, fontSize: 11 }}
                  title="relabel these frames — only needed if the job was filed wrong"
                  onClick={() => setEditClip(true)}
                >
                  ✎
                </button>
              </>
            ) : (
              <>
                <span style={S.note} title="where these frames get filed — this does not generate anything">
                  files as
                </span>
                <select
                  // `borderColor` alone is safe because `S.input` is longhand —
                  // see the note above `card` in theme.ts, and the one on `input`
                  // itself, which this override is what finally converted.
                  style={{ ...S.input, width: 130, ...(clip ? {} : { borderColor: AMBER.fg, color: AMBER.fg }) }}
                  value={clip}
                  onChange={(e) => {
                    setClip(e.target.value);
                    if (e.target.value) setEditClip(false);
                  }}
                >
                  {/* Only offered while nothing is chosen — an unlabelled clip must
                      be a decision, not a state you can go back to by accident. */}
                  {!clip && <option value="">— pick a clip —</option>}
                  {CLIP_NAMES.map((c2) => (
                    <option key={c2} value={c2}>
                      {c2}
                    </option>
                  ))}
                </select>
              </>
            )}
            {frames.length > 1 && (
              <button
                style={{ ...S.btn, ...dimmed }}
                {...addProps}
                title={
                  ghostFlagged.size
                    ? `${ghostFlagged.size} frame(s) with a dissolved limb are left out — see the ✗ marks`
                    : undefined
                }
                onClick={() => addToTray(frames.filter((_, i) => !ghostFlagged.has(i)).map((f) => f.src))}
              >
                {/* The count names what actually goes in. "add all 21" that
                    quietly adds 14 is the kind of silent cap that reads as
                    full coverage when it is not. */}
                + add {frames.length - ghostFlagged.size}
                {ghostFlagged.size ? ` clean of ${frames.length}` : ` all`}
              </button>
            )}
          </div>
          {frames.length > 6 ? (
            <FramePlayer frames={frames} onAdd={addToTray} ghost={job.ghost} />
          ) : (
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 8 }}>
              {frames.map((f, i) => (
                <div key={f.name}>
                  <RetryImg
                    src={`${f.src}&w=256`}
                    alt={f.name}
                    title={ghostFlagged.has(i) ? `${f.name} — dissolved limb (ghost ${job.ghost?.pct?.[i]?.toFixed(2)}%)` : f.name}
                    style={{
                      width: 128, height: 128, objectFit: "contain", background: "#fff", borderRadius: 4,
                      ...(ghostFlagged.has(i) ? { outline: `2px solid ${RED.fg}`, opacity: 0.6 } : {}),
                    }}
                  />
                  <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
                    <button style={{ ...S.btn, fontSize: 11 }} title="chain: next generation starts from this frame" onClick={() => onUseAsInit(f.src)}>
                      → init
                    </button>
                    <button style={{ ...S.btn, fontSize: 11, ...dimmed }} {...addProps} onClick={() => addToTray([f.src])}>
                      + sheet
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {job.mode === "keyframes" && (
            <div style={{ marginTop: 8 }}>
              {!cells && (
                <button
                  style={{ ...S.btn, ...S.btnGreen }}
                  disabled={cutting !== null}
                  onClick={async () => {
                    setCutting("cutting…");
                    try {
                      setCells(await cutSheetToCells(frames[0].src, clip));
                    } catch (e: any) {
                      setCutting(null);
                      // Never surface a bare "undefined": not everything
                      // thrown in a browser is an Error.
                      return alert(`cut failed: ${e?.message ?? String(e)}`);
                    }
                    setCutting(null);
                  }}
                >
                  {cutting ?? "✂ cut into keyframes"}
                </button>
              )}
              {cells && (
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  {cells.map((c2, i) => (
                    <div key={i} style={{ textAlign: "center" }}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={c2} alt={`key ${i + 1}`} title={poseLine(job, i)} style={{ width: 104, height: 104, objectFit: "contain", background: "#fff", borderRadius: 4, imageRendering: "pixelated" }} />
                      <div style={{ display: "flex", gap: 3, marginTop: 3, justifyContent: "center", flexWrap: "wrap" }}>
                        <button style={{ ...S.btn, fontSize: 10, padding: "1px 5px" }} title="first frame of an in-between" onClick={() => onUseAsInit(c2)}>
                          → init
                        </button>
                        <button style={{ ...S.btn, fontSize: 10, padding: "1px 5px" }} title="LAST frame of an in-between — pins where the motion ends" onClick={() => onUseAsLast(c2)}>
                          → last
                        </button>
                        <button style={{ ...S.btn, fontSize: 10, padding: "1px 5px", ...dimmed }} {...addProps} onClick={() => addToTray([c2])}>
                          + sheet
                        </button>
                        <button style={{ ...S.btn, fontSize: 10, padding: "1px 5px" }} title="brush over the wrong part, regenerate only that" onClick={() => onFixFrame(c2)}>
                          ✎ fix
                        </button>
                        <button style={{ ...S.btn, fontSize: 10, padding: "1px 5px" }} title="re-render just this pose" onClick={() => onRedoPose(c2, poseLine(job, i))}>
                          ↻ pose
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function JobsBoard({
  jobs,
  tick,
  modes,
  onCancel,
  onReroll,
  onUseAsInit,
  onUseAsLast,
  onFixFrame,
  onRedoPose,
  onAddToTray,
  onKeep,
  onAllAngles,
}: {
  jobs: Record<string, Job>;
  tick: number;
  /** The mode registry — a card reads its own move presets out of it. */
  modes?: Mode[];
  onCancel: (id: string) => void;
  onReroll: (id: string, job: Job, edits?: { params?: Record<string, string>; prompt?: string; negative?: string }) => void | Promise<void>;
  onUseAsInit: (src: string) => void;
  onUseAsLast: (src: string) => void;
  onFixFrame: (src: string) => void;
  onRedoPose: (src: string, pose: string) => void;
  onAddToTray: (srcs: string[], clip: string) => void;
  onKeep: (id: string, job: Job) => void;
  /** Absent when the panel does not offer the chain (keeps the button off). */
  onAllAngles?: (id: string, job: Job, facings: string[]) => void | Promise<void>;
}) {
  const [showAll, setShowAll] = useState(false);
  const entries = Object.entries(jobs).sort((a, b) => (b[1].startedAt ?? 0) - (a[1].startedAt ?? 0));
  const visible = showAll ? entries : entries.slice(0, 6);
  const live = entries.filter(([, j]) => j.state === "running" || j.state === "queued");
  if (!entries.length) return null;

  /**
   * THE ONE LINE THAT ANSWERS "is it generating?".
   *
   * The chip used to count only what the panel itself had launched, so an
   * unattended `bench-moveset.mjs` sweep — 21 runs and three hours of GPU —
   * read as "0 running · 0 queued" on a page that was otherwise working. The
   * counter was not wrong about its own jobs; it simply had no idea the others
   * existed. Now the rows come from disk with heartbeats, so this counts
   * everything, whoever started it.
   *
   * It names the running job and its elapsed time rather than just a number,
   * because "1 running" and "1 running · S:idle · 6m20s" answer completely
   * different questions when you are waiting on a long sweep.
   */
  const banner = (() => {
    if (!live.length) return null;
    const [, j] = live.find(([, x]) => x.state === "running") ?? live[0];
    // Date.now(), NOT `tick` — see elapsedSecs. `tick` changing is what
    // re-runs this, which is all it was ever good for here.
    const mmss = formatElapsed(elapsedSecs(j.startedAt));
    const pctNum = samplerPct(j.progress);
    return { label: j.label ?? j.mode ?? "job", mmss, pctNum, waiting: live.length - 1 };
  })();

  return (
    <div style={S.card}>
      <h2 style={S.cardTitle}>
        jobs
        <span style={S.chip(live.length ? BLUE.fg : GREY.fg, live.length ? BLUE.bg : GREY.bg)}>
          {entries.filter(([, j]) => j.state === "running").length} running ·{" "}
          {entries.filter(([, j]) => j.state === "queued").length} queued
        </span>
      </h2>
      {banner && (
        <div style={{ margin: "0 0 10px", padding: "8px 10px", borderRadius: 6, background: "#0d1b2e", border: "1px solid #1d3a5c" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#8fc2ff", fontFamily: "monospace" }}>
            {/* A moving element, because a static "running" label is exactly
                what a hung run also looks like. */}
            <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 8, background: "#4da3ff", animation: "forgePulse 1.1s ease-in-out infinite" }} />
            <strong style={{ color: "#cfe6ff" }}>{banner.label}</strong>
            {banner.mmss && <span>· {banner.mmss}</span>}
            {banner.pctNum !== null ? <span>· {banner.pctNum}% sampling</span> : <span style={{ opacity: 0.7 }}>· loading models</span>}
            {banner.waiting > 0 && <span style={{ opacity: 0.7 }}>· {banner.waiting} waiting</span>}
          </div>
          <div style={{ marginTop: 6, height: 4, borderRadius: 4, background: "#12233a", overflow: "hidden" }}>
            <div
              style={
                banner.pctNum !== null
                  ? { height: "100%", width: `${banner.pctNum}%`, background: "#4da3ff", transition: "width .4s linear" }
                  : // Indeterminate: model load emits no progress traffic, and a
                    // 0% bar for 90 seconds reads as a stall.
                    { height: "100%", width: "30%", background: "#2f6ea8", animation: "forgeSlide 1.6s ease-in-out infinite" }
              }
            />
          </div>
          <style>{"@keyframes forgePulse{0%,100%{opacity:1}50%{opacity:.25}}@keyframes forgeSlide{0%{margin-left:-30%}100%{margin-left:100%}}"}</style>
        </div>
      )}
      {visible.map(([id, j]) => (
        <JobCard key={id} id={id} job={j} tick={tick} mode={modes?.find((m) => m.id === j.mode)} onCancel={onCancel} onReroll={onReroll} onUseAsInit={onUseAsInit} onUseAsLast={onUseAsLast} onFixFrame={onFixFrame} onRedoPose={onRedoPose} onAddToTray={onAddToTray} onKeep={onKeep} onAllAngles={onAllAngles} />
      ))}
      {entries.length > 6 && (
        <button style={{ ...S.btn, ...S.btnGhost, marginTop: 8 }} onClick={() => setShowAll(!showAll)}>
          {showAll ? "show fewer" : `show all ${entries.length}`}
        </button>
      )}
    </div>
  );
}
