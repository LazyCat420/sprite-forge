"use client";

/**
 * The /forge panel — a PixelLab-shaped sprite workbench over the local
 * ComfyUI backend, in two working tabs and one plumbing tab:
 *
 *   GENERATE  images in → task (rotate/animate/in-between/edit/touch-up/
 *             pixelize) → jobs board with live progress; every frame can
 *             re-roll, chain as the next init, or join the sheet
 *   SHEET     collected frames → assembled sheet → the real auto-cut and
 *             crush previews → staged into the inbox for `npm run sprites`
 *   BACKEND   server start/stop, settings, the model manager
 *
 * The panel is task-first on purpose: modes and their few fields come from
 * the server's registry (modes.mjs), which owns prompts, LoRA policy and
 * sampler sweet spots. Parameter tinkering belongs in ComfyUI's own
 * frontend against the same server; what wins there gets baked into the
 * registry, not surfaced as another knob here.
 *
 * All talk goes through /api/comfy/* on the Next server (same box as
 * ~/comfy): no CORS, and the Civitai token never reaches this page.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { S } from "./forge/theme";
import type { Job, LibraryState, Manifest, Mode, TrayFrame, SweepState } from "./forge/types";
import { del, postJSON, urlToB64 } from "./forge/api";
import { GenerateCard, type SlotId } from "./forge/GenerateCard";
import { JobsBoard } from "./forge/JobsBoard";
import { SweepBanner } from "./forge/SweepBanner";
import { LibraryCard } from "./forge/LibraryCard";
import { SheetTray } from "./forge/SheetTray";
import { IntakeCard } from "./forge/IntakeCard";
import { InGameCard } from "./forge/InGameCard";
import { ModelsCard, SettingsCard, StatusCard } from "./forge/BackendCards";
import { ModelTestCard } from "./forge/ModelTestCard";

type Tab = "intake" | "generate" | "model-test" | "sheet" | "backend";

/**
 * Content equality for the polled job maps.
 *
 * JSON.stringify is the right tool here and not laziness: these come straight
 * off `res.json()`, so they are plain data with stable key order from the
 * server, and the alternative — a deep-equal helper — is more code for a
 * comparison that runs twice every five seconds on a few dozen small objects.
 */
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export default function ForgePanel() {
  const [m, setM] = useState<Manifest | null>(null);
  const [modes, setModes] = useState<Mode[]>([]);
  const [dlJobs, setDlJobs] = useState<Record<string, { state: string; error?: string }>>({});
  const [genJobs, setGenJobs] = useState<Record<string, Job>>({});
  /** "Is anything running" for the poll cadence — a ref so it cannot re-arm it. */
  const busyRef = useRef(false);
  const [tab, setTab] = useState<Tab>("generate");
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; bad: boolean } | null>(null);
  /** Bumped on every message so a stale expiry cannot wipe a newer one. */
  const toastN = useRef(0);
  const [images, setImages] = useState<Record<SlotId, string | null>>({ init: null, end: null, style: null });
  const [mask, setMask] = useState<string | null>(null);
  const [modeRequest, setModeRequest] = useState<{ id: string; params?: Record<string, string>; n: number } | null>(null);
  const modeReqN = useRef(1);
  const [tray, setTray] = useState<TrayFrame[]>([]);
  const [tick, setTick] = useState(0);
  /**
   * State of a `bench-moveset.mjs` sweep, if one is running. Not a job — see
   * the route's note: a sweep spends 30-90s BETWEEN jobs freeing and reloading
   * ~31GB of weights, so the jobs list is legitimately empty for much of it.
   */
  const [sweep, setSweep] = useState<SweepState | null>(null);
  const [library, setLibrary] = useState<LibraryState>({ projects: [], activeProject: null, characters: [] });
  const [activeCharacter, setActiveCharacter] = useState<string | null>(null);
  const trayKey = useRef(0);

  // The library scans four directories — refreshed on demand (project change,
  // keep, stage), not on the status poll.
  const refreshLibrary = useCallback(async (project?: string) => {
    try {
      const q = project ? `?project=${project}` : "";
      const r = await fetch(`/api/comfy/library${q}`);
      const j = await r.json();
      if (j.projects) setLibrary(j);
    } catch {
      /* backend absent — the manifest gate reports it */
    }
  }, []);
  /**
   * THE BROWSER TAB IS THE STATUS LIGHT.
   *
   * "From my end I have no clue it's running, I have to look at task manager."
   * A banner only helps someone already looking AT the page; a tab title is
   * readable from any other tab, which is where a person waiting three hours
   * for a sweep actually is. Cheap, and it removes the reason to open Task
   * Manager at all.
   */
  useEffect(() => {
    const base = "forge";
    if (!sweep || sweep.finishedAt) {
      document.title = base;
      return;
    }
    const pct = sweep.total > 0 ? Math.round((sweep.completed / sweep.total) * 100) : 0;
    document.title = `▶ ${pct}% ${sweep.current ?? "loading"} — ${base}`;
    return () => { document.title = base; };
  }, [sweep]);

  useEffect(() => {
    void refreshLibrary();
  }, [refreshLibrary]);

  const refresh = useCallback(async () => {
    try {
      const [mr, dr, gr, xr] = await Promise.all([
        fetch("/api/comfy/manifest"),
        fetch("/api/comfy/download"),
        fetch("/api/comfy/generate"),
        fetch("/api/comfy/modes"),
      ]);
      setM(await mr.json());
      const dj = (await dr.json()).jobs ?? {};
      const gpayload = await gr.json();
      const gj = gpayload.jobs ?? {};
      setSweep((prev) => (same(prev, gpayload.sweep ?? null) ? prev : gpayload.sweep ?? null));
      // Same identity-stability rule the modes write below has followed all
      // along. Handing back a fresh object every poll is what fed the loop
      // described on the effect — see there for why this is not cosmetic.
      setDlJobs((prev) => (same(prev, dj) ? prev : dj));
      setGenJobs((prev) => (same(prev, gj) ? prev : gj));
      // The interval's cadence reads this rather than the state, so "is
      // anything running" can change without re-arming the timer.
      busyRef.current =
        Object.values(dj).some((j: any) => j.state === "downloading") ||
        Object.values(gj).some((j: any) => j.state === "running");
      const xj = await xr.json();
      // Only replace the modes array when its content really changed —
      // consumers key field-reset effects off it, and a fresh identity every
      // poll would churn them.
      if (xj.modes) {
        setModes((prev) => (JSON.stringify(prev) === JSON.stringify(xj.modes) ? prev : xj.modes));
      }
      setTick((t) => t + 1);
    } catch {
      /* dev server hiccup — next poll wins */
    }
  }, []);

  /**
   * ── THE POLL LOOP THAT FED ITSELF ───────────────────────────────────────
   *
   * This effect used to depend on `dlJobs` and `genJobs` — the very two states
   * `refresh()` writes. Each write handed back a FRESH OBJECT even when the
   * content was identical, so:
   *
   *     refresh() → new identity → deps changed → effect re-runs
   *              → clearInterval, `void refresh()` IMMEDIATELY, new interval
   *              → new identity → …
   *
   * an unbounded recursion throttled only by network latency, four fetches per
   * lap. The browser eventually reported `net::ERR_INSUFFICIENT_RESOURCES` on
   * /api/comfy/generate and /api/comfy/modes, which reads as the dev server
   * being broken and is not.
   *
   * It was WORST WHILE RENDERING, which is what made it look like a generation
   * problem: a running job updates its progress on every poll, so the content
   * genuinely changed each time and no amount of identity-stability alone would
   * have stopped it. Hence both halves of the fix — dedupe the writes AND take
   * the states out of the deps.
   *
   * `/api/comfy/generate` is not a cheap handler either: it readdirs
   * `work/comfy` and parses every job.json on each call. Hammering it is a
   * large part of "memory ramps up when we render".
   *
   * Self-scheduling timeout rather than setInterval so the cadence can still
   * follow `busyRef` without the effect re-arming. The guard against a
   * post-unmount schedule is the `live` flag, not clearInterval.
   */
  useEffect(() => {
    let live = true;
    let t: ReturnType<typeof setTimeout>;
    const loop = async () => {
      await refresh();
      if (!live) return;
      t = setTimeout(loop, busyRef.current ? 2000 : 5000);
    };
    void loop();
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [refresh]);

  /**
   * ── A FAILURE THAT CLEARS ITSELF IS A FAILURE NOBODY SAW ──────────────────
   *
   * `say` was the only channel, and it wiped after six seconds. So a button
   * that hit a 502 looked identical to a button that did nothing: the reason
   * appeared, uncounted, and then removed itself. Reported twice as "it queues
   * then nothing happens", and both times the server had said exactly what was
   * wrong.
   *
   * Successes still expire — they are noise once read. FAILURES STAY until the
   * next action replaces them, and every one goes to the console as well, so
   * there is a record after the banner is dismissed.
   */
  const say = (s: string) => {
    setToast({ text: s, bad: false });
    const at = ++toastN.current;
    setTimeout(() => setToast((t) => (at === toastN.current ? null : t)), 6000);
  };
  const fail = (s: string, err?: unknown) => {
    toastN.current++;
    setToast({ text: s, bad: true });
    console.error("[forge]", s, err ?? "");
  };

  const setImage = (slot: SlotId, b64: string | null) => setImages((im) => ({ ...im, [slot]: b64 }));

  const addToTray = (srcs: string[], clip: string, facing?: string) => {
    setTray((t) => [...t, ...srcs.map((src) => ({ key: `f${trayKey.current++}`, src, clip, facing }))]);
    say(`${srcs.length} frame(s) → sheet tray (${clip}${facing ? ` · ${facing}` : ""})`);
  };

  const useAsInit = async (src: string) => {
    try {
      setImage("init", await urlToB64(src));
      setMask(null);
      setTab("generate");
      say("frame loaded as the next init");
    } catch (e: any) {
      fail(e.message, e);
    }
  };

  // The keyframe workflow's verbs: pin an in-between's end, brush-fix a
  // cell, or re-render one pose. Each loads the image and STEERS the
  // generate card to the right mode via modeRequest (a nonce so repeat
  // clicks re-fire).
  const requestMode = (id: string, params?: Record<string, string>) =>
    setModeRequest({ id, params, n: modeReqN.current++ });

  const useAsLast = async (src: string) => {
    try {
      setImage("end", await urlToB64(src));
      setTab("generate");
      requestMode("inbetween");
      say("frame pinned as the LAST frame — in-between mode");
    } catch (e: any) {
      fail(e.message, e);
    }
  };

  const fixFrame = async (src: string) => {
    try {
      setImage("init", await urlToB64(src));
      setMask(null);
      setTab("generate");
      requestMode("touchup");
      say("frame loaded — brush over the wrong part");
    } catch (e: any) {
      fail(e.message, e);
    }
  };

  const redoPose = async (src: string, pose: string) => {
    try {
      setImage("init", await urlToB64(src));
      setMask(null);
      setTab("generate");
      requestMode("edit", { prompt: pose ? `Redraw the character in this pose: ${pose}. Same character, same colors, same size, plain white background.` : "" });
      say("pose loaded into edit — tweak the wording and generate");
    } catch (e: any) {
      fail(e.message, e);
    }
  };

  const launch = async (body: Record<string, unknown>) => {
    // Logged without the base64 images — they are megabytes of noise and the
    // interesting part is always the mode, the params and whether an override
    // rode along. This is the line that answers "did the click even fire, and
    // with what", which is the first question every time the board stays empty.
    const { imageB64: _i, endB64: _e, maskB64: _m, styleB64: _s, ...loggable } = body as Record<string, unknown>;
    console.info("[forge] launch", { ...loggable, hasInit: !!body.imageB64 });
    const r = await postJSON("/api/comfy/generate", {
      ...body,
      project: library.activeProject ?? undefined,
      character: activeCharacter ?? undefined,
    });
    console.info("[forge] queued", r.jobIds ?? [r.jobId]);
    say(`${(r.jobIds ?? [r.jobId]).length} job(s) queued${activeCharacter ? ` under ${activeCharacter}` : ""}`);
    void refresh();
  };

  /**
   * Fire a GPU mode and WAIT for its first output frame.
   *
   * Intake is a chain, not a board: the cut-out feeds the reframe feeds the QA,
   * and there is nothing partial worth showing in between. Everywhere else the
   * jobs board is the right shape — a rotation is minutes and you want to watch
   * it — so this variant lives here rather than replacing `launch`.
   */
  const launchAndWait = async (body: Record<string, unknown>): Promise<string | null> => {
    const r = await postJSON("/api/comfy/generate", {
      ...body,
      project: library.activeProject ?? undefined,
      character: activeCharacter ?? undefined,
    });
    const id = (r.jobIds ?? [r.jobId])[0];
    void refresh();
    for (let i = 0; i < 600; i++) {
      await new Promise((res) => setTimeout(res, 2000));
      const s = await (await fetch(`/api/comfy/generate?id=${id}`)).json();
      if (s.state === "running" || s.state === "queued") continue;
      if (s.state !== "done" || !s.frames?.length) {
        fail(s.error ?? `job ${s.state}`);
        return null;
      }
      // The cut-out saves BOTH a cutout and a mask; the cutout is the one that
      // carries alpha, so name-match rather than trusting order.
      const want = s.frames.find((f: string) => f.includes("cut")) ?? s.frames[0];
      return urlToB64(`/api/comfy/generate?id=${id}&frame=${want}`);
    }
    fail("timed out waiting for the job");
    return null;
  };

  /**
   * ONE GOOD CLIP FACING RIGHT → THE SAME MOVE IN EVERY FACING.
   *
   * The workflow this implements is "generate it facing right, look at it, and
   * only then pay for the other angles" — which is the right way round, because
   * a moveset is 18 Wan jobs and the first clip tells you whether the master is
   * worth building on.
   *
   * ── WHY IT ROTATES THE INIT AND NOT THE CLIP ────────────────────────────
   *
   * The tempting shortcut is to rotate the finished frames. That is a restyle
   * of a restyle: Qwen-Image-Edit identity drift compounds over serial edits,
   * which is why PLAN_KEYFRAME_PIPELINE.md's rule is that every facing branches
   * off the ONE approved master and never off another facing. So both rotations
   * start from the same init, and each rotated master is then animated fresh.
   *
   * Sequential, not parallel: Wan wants most of WSL to itself and the RAM guard
   * hard-strikes on sustained pressure. Two facings is 2 x (rotate + animate).
   */
  const allAngles = async (id: string, job: Job, facings: string[]) => {
    if (!job.frames?.length) return fail("no frames on this job to rotate from");
    const preset = job.params?.preset;
    const mins = Math.round((facings.length * (260 + 550)) / 60);
    if (!confirm(`Generate ${preset ?? "this move"} for ${facings.join(" + ")}?\n\n${facings.length * 2} GPU jobs, roughly ${mins} minutes.\nEach facing is rotated from THIS clip's init, never from another facing.`)) return;
    // The init this clip was made from is not on the server, so the first frame
    // is the honest stand-in — it is the same character at the same scale.
    const master = images.init ?? (await urlToB64(`/api/comfy/generate?id=${id}&frame=${job.frames[0]}`));
    for (const facing of facings) {
      say(`${facing}: rotating the master…`);
      const turned = await launchAndWait({ mode: "rotate", params: { facing }, imageB64: master });
      if (!turned) return fail(`${facing}: rotation failed — stopping before it animates the wrong thing`);
      say(`${facing}: animating ${preset ?? ""}…`);
      // `facing` rides along in params so the job label and id carry it; the
      // animate mode ignores it, the route's `facet` does not.
      await launch({ mode: job.mode, params: { ...(job.params ?? {}), facing }, imageB64: turned, fast: job.fast });
    }
    say(`queued ${facings.length} facing(s) — watch the board`);
  };

  const keep = async (id: string, job: Job) => {
    const character = job.character ?? activeCharacter;
    if (!character) return say("select a character in the library first — keep needs to know whose art this is");
    try {
      const r = await postJSON("/api/comfy/pipeline", { op: "keep", character, jobId: id, frames: job.frames ?? [] });
      say(`kept ${r.files.length} frame(s) → ${r.dir}`);
      void refreshLibrary(library.activeProject ?? undefined);
    } catch (e: any) {
      fail(e.message, e);
    }
  };

  /**
   * Run this job's settings again — unchanged (a re-roll) or edited (a new
   * move, a reworded prompt, or both).
   *
   * `edits` is what makes the card's button honest. With none, this is the old
   * behaviour: same params, fresh seed. With them, it is the FIRST render of
   * something that has not existed before, and the card says `▶ run` instead of
   * `↻ re-roll` — because "re-roll" on a clip nobody has generated reads as a
   * promise that it is already sitting somewhere.
   */
  const reroll = async (id: string, job: Job, edits?: { params?: Record<string, string>; prompt?: string; negative?: string }) => {
    try {
      /**
       * ── THIS USED TO BE A DEAD CLICK ─────────────────────────────────────
       *
       * The server keeps no input images, so a re-run needs an init from the
       * browser. When none was loaded this returned a toast and nothing else —
       * and the toast is a line of text that clears itself after six seconds,
       * so pressing the button looked like pressing nothing. Reported as
       * "I click run attack and nothing happens", which is exactly right.
       *
       * A card that is SHOWING frames always has an init available: its own
       * first frame. Fall back to it and say which one was used, rather than
       * refusing to act while the answer is on screen.
       */
      let init = images.init;
      if (!init && job.frames?.length) {
        init = await urlToB64(`/api/comfy/generate?id=${id}&frame=${job.frames[0]}`);
        say(`no init loaded — using this job's first frame (${job.frames[0]})`);
      }
      if (!init) return fail("load an init frame first (→ init on a finished frame)");
      await launch({
        mode: job.mode,
        params: edits?.params ?? job.params ?? {},
        imageB64: init,
        fast: job.fast,
        // Omitted unless the words were actually edited: the registry writes
        // the prompt, and echoing a resolved string back at it would freeze
        // this run against a mode that may since have been improved.
        ...(edits?.prompt ? { prompt: edits.prompt } : {}),
      });
    } catch (e: any) {
      fail(e.message, e);
    }
  };

  if (!m) return <div style={S.page}>loading…</div>;
  if (!m.backendPresent)
    return (
      <div style={S.page}>
        <div style={S.wrap}>
          <h1 style={S.h1}>sprite forge</h1>
          <p style={S.sub}>
            No ComfyUI backend on this machine — expected at {m.comfyHome}. This panel only works on the dev box that
            has the generation stack installed.
          </p>
        </div>
      </div>
    );

  const runningN = Object.values(genJobs).filter((j) => j.state === "running").length;

  /**
   * The library renders on BOTH working tabs, and that is the curation loop:
   * on `generate` it is where a run starts, on `sheet` it is the shelf you
   * pick the keepers off while the tray is on screen beneath it. Choosing
   * frames used to mean scrolling a jobs board on another tab, which is why
   * finished art felt read-only.
   */
  const libraryCard = (
    <LibraryCard
      library={library}
      activeCharacter={activeCharacter}
      onSelectProject={async (id) => {
        try {
          await postJSON("/api/comfy/settings", { project: id });
        } catch {
          /* settings write is best-effort; the query param still switches */
        }
        setActiveCharacter(null);
        void refreshLibrary(id);
      }}
      onSelectCharacter={setActiveCharacter}
      onInit={async (url) => {
        setImage("init", await urlToB64(url));
        setMask(null);
        setTab("generate");
        say("library art loaded as the init frame");
      }}
      onStyle={async (url) => {
        setImage("style", await urlToB64(url));
        say("library art loaded as the style ref");
      }}
      onSheet={addToTray}
    />
  );

  return (
    <div style={S.page}>
      <div style={S.wrap}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
          <h1 style={S.h1}>sprite forge</h1>
          <span style={S.chip(m.comfy.reachable ? "#8fdd9f" : "#dd8f8f", m.comfy.reachable ? "#16281c" : "#281616")}>
            {m.comfy.reachable ? `backend up · ${m.comfy.vramFreeGiB}GiB free` : "backend down"}
          </span>
          {m.comfy.reachable && (
            <button
              style={{ ...S.btn, ...S.btnGhost, fontSize: 11, padding: "2px 8px" }}
              onClick={async () => {
                try {
                  await postJSON("/api/comfy/server", { action: "free" });
                  say("models unloaded & RAM freed");
                  void refresh();
                } catch (e: any) {
                  fail(e.message, e);
                }
              }}
            >
              clear memory 🧹
            </button>
          )}
          {runningN > 0 && <span style={S.chip("#9fd0ff", "#16202b")}>{runningN} generating</span>}
          <span style={{ flex: 1 }} />
          {(["intake", "generate", "model-test", "sheet", "backend"] as Tab[]).map((t) => (
            <button key={t} style={{ ...S.btn, ...(tab === t ? S.btnGreen : {}) }} onClick={() => setTab(t)}>
              {t === "model-test" ? "test models" : t}
              {t === "sheet" && tray.length > 0 ? ` (${tray.length})` : ""}
            </button>
          ))}
        </div>
        <p style={S.sub}>
          frames in → move sets out · generated art lands in sprite-forge/work/comfy/ · a staged sheet publishes with
          `npm run sprites`
        </p>
        {toast && (
          <div
            style={{
              ...S.card,
              borderColor: toast.bad ? "#5a2c2c" : "#4a3a2c",
              color: toast.bad ? "#ffb0b0" : "#ffd9a0",
              // Server messages are multi-line now (the guard log tail rides
              // along), and collapsing them was hiding the actionable half.
              whiteSpace: "pre-wrap",
              fontFamily: toast.bad ? "ui-monospace, monospace" : undefined,
              fontSize: toast.bad ? 12 : undefined,
              display: "flex",
              gap: 12,
              alignItems: "flex-start",
            }}
          >
            <span style={{ flex: 1 }}>{toast.text}</span>
            {toast.bad && (
              <button style={{ ...S.btn, ...S.btnGhost }} onClick={() => setToast(null)}>
                dismiss
              </button>
            )}
          </div>
        )}

        {tab === "generate" && (
          <>
            {libraryCard}
            <GenerateCard
              modes={modes}
              reachable={m.comfy.reachable}
              images={images}
              setImage={setImage}
              mask={mask}
              setMask={setMask}
              modeRequest={modeRequest}
              onLaunch={launch}
              say={say}
            />
            <SweepBanner sweep={sweep} now={Date.now()} />
            <JobsBoard
              jobs={genJobs}
              tick={tick}
              modes={modes}
              onCancel={async (id) => {
                try {
                  await del(`/api/comfy/generate?id=${id}`);
                  say("cancelled");
                  void refresh();
                } catch (e: any) {
                  fail(e.message, e);
                }
              }}
              onReroll={reroll}
              onAllAngles={allAngles}
              onUseAsInit={useAsInit}
              onUseAsLast={useAsLast}
              onFixFrame={fixFrame}
              onRedoPose={redoPose}
              onAddToTray={addToTray}
              onKeep={keep}
            />
          </>
        )}

        {tab === "model-test" && (
          <>
            {libraryCard}
            <ModelTestCard
              modes={modes}
              images={images}
              onSetImage={setImage}
              onClearImage={(slot) => setImage(slot, null)}
              onGenerate={async (req) => {
                await launch({
                  mode: req.mode,
                  params: req.params,
                  prompt: req.prompt,
                  seed: req.seed,
                  small: req.small,
                  imageB64: images.init,
                  endB64: images.end,
                });
              }}
              busy={busyRef.current}
              activeCharacter={activeCharacter}
            />
            <JobsBoard
              jobs={genJobs}
              tick={tick}
              modes={modes}
              onCancel={async (id) => {
                try {
                  await del(`/api/comfy/generate?id=${id}`);
                  say("cancelled");
                  void refresh();
                } catch (e: any) {
                  fail(e.message, e);
                }
              }}
              onReroll={reroll}
              onAllAngles={allAngles}
              onUseAsInit={useAsInit}
              onUseAsLast={useAsLast}
              onFixFrame={fixFrame}
              onRedoPose={redoPose}
              onAddToTray={addToTray}
              onKeep={keep}
            />
          </>
        )}

        {tab === "intake" && (
          <IntakeCard
            modes={modes}
            reachable={m.comfy.reachable}
            say={say}
            onLaunch={launchAndWait}
            onUseAsInit={async (b64) => {
              setImage("init", b64);
              setMask(null);
              setTab("generate");
              requestMode("keyframes");
              say("intake frame is the character — keyframes mode");
            }}
          />
        )}

        {tab === "sheet" && (
          <>
            {libraryCard}
            <SheetTray
              tray={tray}
              setTray={setTray}
              say={say}
              suggestedName={activeCharacter ? `${activeCharacter}-E` : ""}
              onStaged={() => void refreshLibrary(library.activeProject ?? undefined)}
            />
            {/* Staging ends at the inbox; this is the rest of the road. */}
            <InGameCard say={say} />
          </>
        )}

        {tab === "backend" && (
          <>
            <StatusCard
              m={m}
              busy={busy}
              onAction={async (a) => {
                setBusy(a);
                try {
                  const r = await postJSON("/api/comfy/server", { action: a });
                  say(a === "start" ? (r.up ? "server is up" : r.note ?? "starting…") : "server stopped");
                } catch (e: any) {
                  fail(e.message, e);
                } finally {
                  setBusy(null);
                  void refresh();
                }
              }}
            />
            <SettingsCard
              m={m}
              onSave={async (patch) => {
                try {
                  await postJSON("/api/comfy/settings", patch);
                  say("settings saved");
                } catch (e: any) {
                  fail(e.message, e);
                } finally {
                  void refresh();
                }
              }}
            />
            <ModelsCard
              m={m}
              dlJobs={dlJobs}
              onDownload={async (id) => {
                try {
                  await postJSON("/api/comfy/download", { optionId: id });
                } catch (e: any) {
                  fail(e.message, e);
                } finally {
                  void refresh();
                }
              }}
              onChoose={async (slotId, optionId) => {
                try {
                  await postJSON("/api/comfy/settings", { chosen: { [slotId]: optionId } });
                  say("selection saved — generation will use it");
                } catch (e: any) {
                  fail(e.message, e);
                } finally {
                  void refresh();
                }
              }}
            />
          </>
        )}
      </div>
    </div>
  );
}
