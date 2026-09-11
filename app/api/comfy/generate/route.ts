/**
 * Generation jobs — every mode the panel offers, server-side.
 *
 *   POST {mode, params, imageB64, ...}   → {jobIds}  (returns immediately)
 *   GET  ?id=<jobId>                     → job status: progress, frames, prompt
 *   GET  ?id=<jobId>&frame=<filename>    → one output PNG
 *   GET  ?id=<jobId>&preview=1           → latest live sampler preview (JPEG)
 *   GET  (bare)                          → every job this server knows
 *   DELETE ?id=<jobId>                   → interrupt (running) / dequeue (pending)
 *
 * A rotation is minutes even in fast mode, so this is a job store, not a
 * held-open request. Frames land in sprite-forge's gitignored
 * work/comfy/<job>/ — the same place the CLI writes — and stream back
 * through this route so the browser needs no other path into the
 * filesystem. Each job also writes a job.json there: the in-memory Map
 * dies on dev reload, and a recovered job should keep its mode, prompt and
 * params, not just its frames.
 *
 * WHAT DECIDES A JOB IS DONE: /history polling (client.waitFor), exactly as
 * before. The websocket only feeds the progress fields — ComfyUI documents
 * progress traffic can trail completion (#9330), so it must never drive
 * state.
 *
 * The graphs come from modes.mjs — the one registry of prompts, LoRA
 * policy and coupled sampler bundles. This route's job is transport:
 * uploads in, jobs out.
 */
import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  assertNodes,
  cancelPrompt,
  fetchImage,
  freeMemory,
  outputImages,
  queuePrompt,
  setComfyUrl,
  uploadImage,
  waitFor,
  watchProgress,
} from "../../../../src/game/pinball-knight/tools/sprite-forge/comfy/client.mjs";
import { modeById, fastAvailable, smallAvailable } from "../../../../src/game/pinball-knight/tools/sprite-forge/comfy/modes.mjs";
import { optionById, chosenOption } from "../../../../src/game/pinball-knight/tools/sprite-forge/comfy/manifest.mjs";
import {
  backendPresent,
  installState,
  loadSettings,
  modelsDir,
} from "../../../../src/game/pinball-knight/tools/sprite-forge/comfy/forge-config.mjs";

export const dynamic = "force-dynamic";

const WORK = join(process.cwd(), "src/game/pinball-knight/tools/sprite-forge/work/comfy");

type Progress = { node: string | null; value: number; max: number };
type Job = {
  state: "queued" | "running" | "done" | "error" | "cancelled";
  /** Which model stack this job needs — the scheduler groups by it. */
  leg?: string;
  mode: string;
  label: string;
  startedAt: number;
  params?: Record<string, unknown>;
  resolvedPrompt?: string;
  /** The NEGATIVE actually sent — read off the built graph, not recomputed. */
  resolvedNegative?: string;
  seed?: number;
  fast?: boolean;
  /** Ran on the small animation leg (TI2V-5B) rather than the A14B expert pair. */
  small?: boolean;
  /** Library filing: which project/character this generation belongs to. */
  project?: string;
  character?: string;
  /** The game clip the preset targets — pre-selects the sheet tray's dropdown. */
  clip?: string;
  promptId?: string;
  progress?: Progress;
  previewB64?: string;
  frames?: string[];
  error?: string;
  tookS?: number;
  /**
   * Per-frame ghost score — see `sprite-forge/ghost.ts`. Written once, when the
   * frames land, because that is the only moment they exist un-matted and the
   * metric's separation collapses after a key (95x → 2x, measured).
   */
  ghost?: { pct: number[]; flagged: number[]; soft: number[]; level: string };
};
const jobs: Map<string, Job> = (globalThis as any).__forgeGen ?? new Map();

/**
 * How long a CLI run may go without touching job.json before it is presumed
 * dead. It heartbeats on sampler progress (throttled to ~1.5s), but the quiet
 * stretches are the honest constraint: model LOAD is ~31GB of reads with no
 * progress traffic at all, and the VAE decode at the end is another silent
 * gap. Both have been measured over a minute on this box, so a 20s window
 * would report every healthy run as dead twice per generation.
 */
const STALE_MS = 180_000;
(globalThis as any).__forgeGen = jobs;

/** What survives a dev-server reload, minus the volatile fields. */
function persistJob(id: string) {
  const j = jobs.get(id);
  if (!j) return;
  const { previewB64: _p, progress: _g, ...keep } = j;
  try {
    mkdirSync(join(WORK, id), { recursive: true });
    writeFileSync(join(WORK, id, "job.json"), JSON.stringify(keep, null, 1));
  } catch {
    /* job dir may not exist yet on early errors — the Map still has it */
  }
}

/** The PNGs a job dir really holds, sorted — the truth about its frames. */
function framesOnDisk(id: string): string[] {
  try {
    return readdirSync(join(WORK, id))
      .filter((f) => f.endsWith(".png"))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Why the backend is not answering, in the words of the thing that stopped it.
 *
 * The RAM guard writes one line per strike naming the cause, and a SOFT strike
 * writes no `guard-tripped.json` — so the log is the only place it is recorded.
 * It also strikes on WINDOWS HOST pressure, which `free` inside WSL cannot see:
 * 2026-08-07 lost several runs with the host at 61.7GB while WSL reported 26GB
 * available throughout. Without these lines the panel shows "fetch failed" and
 * the obvious inference — something is broken in the code — is wrong.
 */
function guardHint(detail?: string): string {
  let tail = "";
  try {
    const lines = readFileSync(join(homedir(), "comfy", "guard.log"), "utf8").trimEnd().split("\n");
    tail = lines.slice(-3).join("\n");
  } catch {
    tail = "(no ~/comfy/guard.log)";
  }
  return (
    `The RAM guard is the usual cause. It strikes on Windows host memory too, which\n` +
    `free(1) inside WSL cannot see.\n\n` +
    `Last guard lines:\n${tail}\n\n` +
    `Restart:  ~/comfy/run.sh -d${detail ? `\n\n(${detail})` : ""}`
  );
}

/**
 * The negative text on a built graph.
 *
 * Every graph in `graphs.mjs` names the node `neg`; only the field differs —
 * `CLIPTextEncode` calls it `text`, `TextEncodeQwenImageEditPlus` calls it
 * `prompt`. Typed loosely on purpose: a graph is a JSON document whose shape is
 * a union across four builders, and narrowing it here would mean restating that
 * union in a second place that then has to be kept in step.
 */
function negField(graph: any): "text" | "prompt" | null {
  const inputs = graph?.neg?.inputs;
  if (!inputs) return null;
  if (typeof inputs.text === "string") return "text";
  if (typeof inputs.prompt === "string") return "prompt";
  return null;
}
function readNegative(graph: any): string | undefined {
  const k = negField(graph);
  return k ? (graph.neg.inputs[k] as string) : undefined;
}
function setNegative(graph: any, text: string): void {
  const k = negField(graph);
  if (k) graph.neg.inputs[k] = text;
}

async function uploadB64(b64: string, tag: string): Promise<string> {
  const tmp = join(tmpdir(), `forge-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.png`);
  writeFileSync(tmp, Buffer.from(String(b64).replace(/^data:image\/\w+;base64,/, ""), "base64"));
  return uploadImage(tmp, `forge-${tag}-${Date.now()}.png`);
}

/**
 * Score a finished clip for dissolved limbs, ON THE RAW FRAMES.
 *
 * ── WHY THIS IS ALLOWED TO FAIL SOFT, AND WHERE THE REAL GATE IS ────────────
 *
 * `canvas` is a native module and this runs inside Next's server runtime, which
 * is exactly the sort of place a .node binary goes missing after a rebuild. The
 * frames are already paid for by the time we get here, so a decoder that will
 * not load must not throw away the generation — it degrades to "no ghost data"
 * and says so in the log.
 *
 * That makes this an INSTRUMENT, not the guard. The guard is fail-closed and
 * lives where art gets published (`prep-clips` / `driftRow`); a missing score
 * here shows up as a job card with no badges, which reads as "not measured"
 * rather than "measured clean" because the panel keys off `ghost` being absent.
 */
async function scoreGhosts(dir: string, frames: string[]): Promise<Job["ghost"]> {
  if (frames.length < 2) return undefined;
  try {
    const importMod = new Function("p", "return import(p)");
    const { loadImage, createCanvas } = await importMod("canvas");
    const { ghostClip } = await import("@/src/game/pinball-knight/tools/sprite-forge/ghost");
    const cells = [];
    for (const name of frames) {
      const img = await loadImage(join(dir, name));
      const c = createCanvas(img.width, img.height);
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, img.width, img.height);
      cells.push({ width: img.width, height: img.height, data: d.data as unknown as Uint8ClampedArray });
    }
    const v = ghostClip(cells);
    return { pct: v.pct.map((p) => Number((p * 100).toFixed(2))), flagged: v.flagged, soft: v.soft, level: v.level };
  } catch (e: any) {
    console.warn(`[forge] ghost scoring skipped: ${e?.message ?? e}`);
    return undefined;
  }
}

async function runJob(id: string, graph: any, clientId: string) {
  const t0 = Date.now();
  const job = jobs.get(id)!;
  try {
    await assertNodes(graph);
    const promptId = await queuePrompt(graph, { clientId });
    job.promptId = promptId;
    persistJob(id);
    const stopWatch = watchProgress(promptId, clientId, {
      onProgress: (p: Progress) => {
        const j = jobs.get(id);
        if (j && j.state === "running") j.progress = p;
      },
      onPreview: (buf: Buffer) => {
        const j = jobs.get(id);
        if (j && j.state === "running") j.previewB64 = buf.toString("base64");
      },
    });
    let history;
    try {
      history = await waitFor(promptId);
    } finally {
      stopWatch();
    }
    const dir = join(WORK, id);
    mkdirSync(dir, { recursive: true });
    const frames: string[] = [];
    for (const im of outputImages(history)) {
      const name = im.filename.replace(/.*\//, "");
      writeFileSync(join(dir, name), await fetchImage(im));
      frames.push(name);
    }
    Object.assign(job, { state: "done", frames, tookS: Math.round((Date.now() - t0) / 1000), progress: undefined, previewB64: undefined });
    job.ghost = await scoreGhosts(dir, frames);
  } catch (e: any) {
    // A cancel surfaces here as an interrupted history or a timeout — keep
    // the cancelled state if DELETE already set it.
    if (jobs.get(id)?.state !== "cancelled") {
      Object.assign(job, { state: "error", error: e.message ?? String(e) });
    }
  }
  persistJob(id);
}

/**
 * LEG-AFFINITY SCHEDULER — the model-switch lag fix.
 *
 * A Qwen↔Wan switch costs a full unload + a 12-15GB reload, minutes each
 * way. ComfyUI's own queue is FIFO and doesn't know legs exist, so a
 * mixed queue (a move-set batch plus one rotate) used to thrash:
 * load Wan, unload, load Qwen, unload, load Wan…
 *
 * This scheduler runs ONE job at a time and drains every parked job of
 * the RESIDENT leg before switching; /free happens exactly once per real
 * switch, never per job. While the resident leg samples (GPU-bound), the
 * OTHER leg's model files are read into the page cache at idle priority —
 * page cache is reclaimable (it cannot re-create the freeze; the kernel
 * evicts it under pressure), so when the switch finally happens the
 * "reload from disk" is mostly a copy from RAM.
 *
 * Parked graphs live in memory only: a dev reload loses them, and GET
 * reports such jobs as errors with a re-roll hint — recovery would need
 * re-uploaded images, which is the user's one click anyway.
 */
type Parked = { id: string; graph: unknown; clientId: string; leg: string };
type Sched = {
  resident: string | null;
  runningId: string | null;
  parked: Parked[];
  warmedLeg: string | null;
  gateTimer: ReturnType<typeof setTimeout> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
};
const sched: Sched = (globalThis as any).__forgeSched ?? {
  resident: null,
  runningId: null,
  parked: [],
  warmedLeg: null,
  gateTimer: null,
  idleTimer: null,
};
(globalThis as any).__forgeSched = sched;

/**
 * Idle hygiene: on the 40GB-capped VM an idle ComfyUI with cached stacks
 * rests LOW — ~2.8GiB after one leg, ~1.5-2.4 after a two-leg session,
 * which sits under the guard's sustained rule (2.5GiB/60s) and tripped
 * an idle healthy server twice on 08-05. So the grace is conditional:
 * a drained queue on a squeezed box frees NOW (a warm cache below the
 * watchdog line is worth less than the fragility), and only a box with
 * real headroom keeps the 5-minute warm-cache window for rapid
 * iteration. resident goes null so the next dispatch knows nothing
 * needs freeing.
 */
const IDLE_KEEP_WARM_GIB = 4;
function idleFree() {
  sched.resident = null;
  freeMemory().catch(() => {
    /* server already down — nothing cached anyway */
  });
}
function scheduleIdleFree() {
  if (sched.idleTimer) clearTimeout(sched.idleTimer);
  const avail = ramAvailGiB();
  if (avail !== null && avail < IDLE_KEEP_WARM_GIB) return idleFree();
  sched.idleTimer = setTimeout(() => {
    sched.idleTimer = null;
    if (sched.runningId || sched.parked.length) return;
    idleFree();
  }, 5 * 60_000);
}

/**
 * The model files a leg loads — what prefetch warms, and what the scheduler
 * treats as one resident stack.
 *
 * ⚠️ `wan-small` IS ITS OWN LEG, not a variant of `wan`. It loads a different
 * unet AND a different VAE, so grouping it with the A14B pair would (a) make
 * the affinity scheduler think no switch was needed between two stacks that do
 * not share a single weight, and (b) point `prefetchLeg` at 24GB of experts
 * that the run will never open — which is precisely the 24GB of page cache the
 * small leg exists to avoid reading.
 *
 * It names EXACT option ids rather than slot choices because the 5B path needs
 * the 2.2 VAE specifically, and `anim-vae`'s recommended (hence usually chosen)
 * option is the 2.1 one.
 */
const SMALL_LEG_OPTIONS = ["wan-ti2v-5b-q8", "wan-ti2v-5b-q6", "umt5-fp8", "wan22-vae"];

function legFiles(leg: string): string[] {
  const chosen = loadSettings().chosen;
  const files =
    leg === "wan-small"
      ? SMALL_LEG_OPTIONS.map((id) => optionById(id)?.file)
      : (leg === "wan" ? ["anim-high", "anim-low", "anim-te", "anim-vae"] : ["rot-unet", "rot-te", "rot-vae"]).map(
          (s) => chosenOption(s, chosen)?.file,
        );
  return files
    .filter((f): f is string => !!f)
    .map((f) => join(modelsDir(), f))
    .filter((p) => existsSync(p));
}

/**
 * Idle-priority read of a leg's files into the page cache — OFF by default.
 *
 * Measured on 2026-08-05: warming Wan's 24GB while Qwen loaded pushed HOST
 * used memory to 62GB and the guard (correctly) killed the stack. Inside
 * WSL the page cache is reclaimable; to Windows the ballooned VM is just
 * gone — an unconfigured WSL2 never hands cache back. Only enable this
 * (FORGE_PREFETCH=1) after capping WSL in .wslconfig with
 * autoMemoryReclaim=gradual, which makes the cache actually returnable.
 */
function prefetchLeg(leg: string) {
  if (process.env.FORGE_PREFETCH !== "1") return;
  if (sched.warmedLeg === leg) return;
  sched.warmedLeg = leg;
  const files = legFiles(leg);
  if (!files.length) return;
  // stdio "ignore" wires cat's stdout to /dev/null — the bytes only ever
  // touch the page cache, which is the entire point.
  const p = spawn("nice", ["-n", "19", "cat", ...files], { stdio: ["ignore", "ignore", "ignore"], detached: true });
  p.unref();
}

function pump() {
  if (sched.runningId || !sched.parked.length) return;
  // Dispatch-time RAM gate: a dispatch is the moment 15-25GB gets promised,
  // so tightness here means WAIT (the job stays queued and visible), not
  // fail — load transients pass in seconds.
  const avail = ramAvailGiB();
  if (avail !== null && avail < RAM_GATE_GIB) {
    if (!sched.gateTimer) {
      sched.gateTimer = setTimeout(() => {
        sched.gateTimer = null;
        pump();
      }, 15_000);
    }
    return;
  }
  // A dispatch is imminent — the warm cache is about to be wanted again.
  if (sched.idleTimer) {
    clearTimeout(sched.idleTimer);
    sched.idleTimer = null;
  }
  // Drain the resident leg first; switch only when it has nothing left.
  let idx = sched.parked.findIndex((p) => p.leg === sched.resident);
  const switching = idx < 0;
  if (switching) idx = 0;
  const next = sched.parked.splice(idx, 1)[0];
  const job = jobs.get(next.id);
  if (!job || job.state !== "queued") return pump();
  sched.runningId = next.id;
  job.state = "running";
  persistJob(next.id);
  void (async () => {
    try {
      if (switching && sched.resident !== null) {
        // The 24GB card cannot hold both stacks (measured OOM on 08-04);
        // exactly one /free per real switch, then the cold start.
        try {
          await freeMemory();
        } catch {
          /* server down surfaces at queue time with its own message */
        }
        sched.warmedLeg = null;
      }
      sched.resident = next.leg;
      // Warm the OTHER pending leg while this one holds the GPU.
      const other = sched.parked.find((p) => p.leg !== next.leg);
      if (other) prefetchLeg(other.leg);
      await runJob(next.id, next.graph, next.clientId);
    } finally {
      sched.runningId = null;
      pump();
      if (!sched.runningId && !sched.parked.length) scheduleIdleFree();
    }
  })();
}

/**
 * The dispatch-time RAM gate: tightness means the queued job WAITS, so
 * this floor decides "is the box being eaten by something ELSE" — and it
 * must sit BELOW the loaded-model steady state or it deadlocks the queue.
 * Measured on the 40GB-capped VM: a finished Qwen job idles at 9.3-9.5GiB
 * available (a 10GiB floor waited on headroom that can never appear —
 * the next dispatch's own /free is what releases it). 6 clears that state
 * while still catching genuinely external pressure above the guard's
 * soft floor (5).
 */
const RAM_GATE_GIB = Number(process.env.FORGE_RAM_GATE_GIB ?? 6);
function ramAvailGiB(): number | null {
  try {
    const m = /MemAvailable:\s+(\d+) kB/.exec(readFileSync("/proc/meminfo", "utf8"));
    return m ? Number(m[1]) / 2 ** 20 : null;
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  if (!backendPresent()) return NextResponse.json({ error: "no backend on this machine" }, { status: 404 });
  const settings = loadSettings();
  setComfyUrl(settings.comfyUrl);

  let avail = ramAvailGiB();
  if (avail !== null && avail < 3.0) {
    try { await freeMemory(); } catch { /* best effort */ }
    avail = ramAvailGiB();
  }
  if (avail !== null && avail < 1.5) {
    return NextResponse.json(
      {
        error:
          `RAM guard: only ${avail.toFixed(1)}GiB of system RAM is available — the box is squeezed. ` +
          `Close whatever is eating RAM (tests, other sessions), or restart ComfyUI backend to drop cached models.`,
      },
      { status: 503 },
    );
  }
  const body = await req.json();
  const mode = modeById(body.mode ?? body.kind); // `kind` — pre-modes clients
  if (!mode) return NextResponse.json({ error: `unknown mode ${body.mode ?? body.kind}` }, { status: 400 });
  if (mode.needs.init === true && !body.imageB64) {
    return NextResponse.json({ error: "imageB64 is required — pick an init frame first" }, { status: 400 });
  }
  if (mode.needs.end && !body.endB64) return NextResponse.json({ error: "this mode needs a last frame too" }, { status: 400 });
  if (mode.needs.mask && !body.maskB64) return NextResponse.json({ error: "this mode needs a brushed mask" }, { status: 400 });

  const images: Record<string, string | null> = { init: null, end: null, mask: null, style: null };
  try {
    if (body.imageB64) images.init = await uploadB64(body.imageB64, "init");
    if (body.endB64) images.end = await uploadB64(body.endB64, "end");
    if (body.maskB64) images.mask = await uploadB64(body.maskB64, "mask");
    if (body.styleB64) images.style = await uploadB64(body.styleB64, "style");
  } catch (e: any) {
    // `ComfyUI unreachable: fetch failed` is true and useless. The cause is
    // almost always the RAM guard, which names itself in one line in its own
    // log — and it strikes on WINDOWS host pressure too, which nothing inside
    // WSL can see. `cli.mjs` learned to quote that log after two sessions read
    // the bare string as a model or settings fault; the panel had not.
    console.error("[forge] upload failed — ComfyUI unreachable", e);
    return NextResponse.json({ error: `ComfyUI is not answering at ${settings.comfyUrl}.\n\n${guardHint(e.message)}` }, { status: 502 });
  }

  const has = (optionId: string) => {
    const o = optionById(optionId);
    return o ? installState(o).state === "installed" : false;
  };
  const baseSeed = Number.isFinite(+body.seed) ? +body.seed : Math.floor(Math.random() * 1e9);
  const fast = !!body.fast && fastAvailable(mode.leg, has);
  // Same shape as `fast`: the request may ask, and the server decides whether
  // the weights are actually there. Asking for a leg that is not installed
  // falls back to A14B rather than failing, because a missing OPTIONAL model is
  // not a bad request — but `small` is echoed onto the job so the card says
  // which leg actually ran instead of which one was requested.
  const small = !!body.small && smallAvailable(mode.leg, has);

  // A batch is N independent jobs, not one graph: the scheduler runs them
  // in turn and each gets its own card, cancel and re-roll in the panel.
  const batch = body.batch && mode.batch && mode.batch.id === body.batch ? mode.batch : null;
  const runs: Array<Record<string, unknown>> = batch
    ? batch.values.map((v: Record<string, unknown>) => ({ ...body.params, ...v }))
    : [{ ...(body.params ?? {}) }];

  const jobIds: string[] = [];
  for (const params of runs) {
    const ctx = {
      has,
      lora: (optionId: string) => optionById(optionId)?.file.replace(/^loras\//, "") ?? null,
      unet: (slotId: string) => chosenOption(slotId, settings.chosen)?.file.replace(/^unet\//, "") ?? null,
      /** The chosen OPTION ID for a pick-one slot — for slots whose file is not a unet. */
      chosen: (slotId: string) => chosenOption(slotId, settings.chosen)?.id ?? null,
      /**
       * Any option's filename, by OPTION id, with its models/ subdirectory
       * stripped — ComfyUI loaders take a name relative to their own folder.
       * `unet()` takes a SLOT and only works for unets; this is for the cases
       * that name one exact weight (the 5B quant, the 2.2 VAE).
       */
      fileOf: (optionId: string) => optionById(optionId)?.file.replace(/^[^/]+\//, "") ?? null,
      fast,
      small,
      images,
      seed: baseSeed,
    };
    /**
     * AN EDITED PROMPT, WITHOUT A SECOND PROMPT PATH.
     *
     * `modes.mjs` is the one registry of prompts and this must not become a
     * rival to it: the override replaces the mode's `prompt()` for this ONE
     * job and nothing else. Every mode's `build` calls `this.prompt(params,
     * ctx)`, so swapping that single method on a shallow copy reaches the
     * graph, the recorded `resolvedPrompt` and the panel's re-roll alike —
     * there is no path where the picture and the record disagree.
     *
     * What it deliberately does NOT override: `preset.avoid`, which becomes
     * the negative. Those clauses were each added off a measured failure (the
     * frog's gliding feet, the death clips dissolving into VFX) and they are
     * not what a user is editing when they reword an action.
     *
     * ⚠️ It DOES let a trigger word be deleted. `pix3lwalk` is prepended by
     * `animate`'s `prompt()` when the walk LoRA is installed; edit that out
     * and the LoRA is still loaded but never fires. The panel pre-fills the
     * resolved prompt so the trigger is there unless it is removed on purpose.
     */
    const override = typeof body.prompt === "string" && body.prompt.trim() ? body.prompt.trim() : null;
    let graph, resolvedPrompt;
    try {
      resolvedPrompt = override ?? mode.prompt(params, ctx);
      graph = (override ? { ...mode, prompt: () => override } : mode).build(params, ctx);
    } catch (e: any) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }

    /**
     * THE NEGATIVE — recorded, and editable, because it is half the prompt.
     *
     * It was never written down anywhere. `wanI2V` carries a long default (the
     * camera terms, the scale terms, the background terms) and each mode adds
     * its preset's `avoid` on top, and none of that reached `job.json` or the
     * panel. So "show me the prompt that made this image" could only ever show
     * half of it, and the half that is doing the most work on a video model was
     * invisible: the reason a walk does not glide is a clause in there.
     *
     * Read off the BUILT GRAPH rather than recomputed, so it is literally the
     * string being sent. Every graph names the node `neg`; only the field
     * differs — `CLIPTextEncode` calls it `text`, `TextEncodeQwenImageEditPlus`
     * calls it `prompt`.
     */
    const negOverride = typeof body.negative === "string" && body.negative.trim() ? body.negative.trim() : null;
    if (negOverride) setNegative(graph, negOverride);
    const resolvedNegative = readNegative(graph);
    const facet =
      typeof params.facing === "string" ? `-${params.facing}` : typeof params.preset === "string" && params.preset !== "custom" ? `-${params.preset}` : "";
    const preset = mode.presets?.find((p: { id: string }) => p.id === params.preset);
    const id = `${mode.id}${facet}-${Date.now().toString(36)}-${jobIds.length}`;
    const clientId = randomUUID();
    jobs.set(id, {
      state: "queued",
      leg: mode.leg,
      mode: mode.id,
      label: `${mode.title}${facet}`,
      startedAt: Date.now(),
      params,
      resolvedPrompt,
      resolvedNegative,
      seed: baseSeed,
      fast,
      small,
      // The clip these frames are destined for — the sheet tray's default.
      clip: preset?.clip || undefined,
      // Filing tags flow into job.json, which is what the library scans —
      // a tagged generation shows up under its character with no file moves.
      project: typeof body.project === "string" ? body.project : undefined,
      character: typeof body.character === "string" ? body.character : undefined,
    });
    persistJob(id);
    // The RESIDENT-STACK key, which is not the same thing as the job's leg: a
    // 5B run and an A14B run share no weight, so they must not be batched as
    // one residency. `job.leg` above stays `mode.leg` — that is what the panel
    // groups cards by, and a user thinks of both as "animate".
    sched.parked.push({ id, graph, clientId, leg: small ? "wan-small" : mode.leg });
    jobIds.push(id);
  }
  pump();
  return NextResponse.json({ jobIds, jobId: jobIds[0] });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const frame = url.searchParams.get("frame");

  /**
   * `?resolve=<modeId>&params=<json>` — what prompt WOULD this run use?
   *
   * The panel needs it to show an editable prompt for a move that has not been
   * generated yet. It could have templated the string client-side instead, and
   * that is precisely the mistake: `modes.mjs` is the one registry of prompts,
   * a second copy of the template drifts from it silently, and a reimplemented
   * copy cannot see the original change. So the panel asks the registry.
   *
   * Pure and cheap — no ComfyUI, no upload, no job. `has()` reports installed
   * options because a trigger word like `pix3lwalk` is only prepended when its
   * LoRA is actually there, and the user must see the prompt that will run.
   */
  const resolve = url.searchParams.get("resolve");
  if (resolve) {
    const mode = modeById(resolve);
    if (!mode) return NextResponse.json({ error: `unknown mode ${resolve}` }, { status: 404 });
    let params: Record<string, unknown> = {};
    try {
      params = JSON.parse(url.searchParams.get("params") ?? "{}");
    } catch {
      return NextResponse.json({ error: "params must be JSON" }, { status: 400 });
    }
    const settings = loadSettings();
    const has = (optionId: string) => {
      const o = optionById(optionId);
      return o ? installState(o).state === "installed" : false;
    };
    try {
      const ctx = {
        has,
        lora: (o: string) => optionById(o)?.file.replace(/^loras\//, "") ?? null,
        unet: (s: string) => chosenOption(s, settings.chosen)?.file.replace(/^unet\//, "") ?? null,
        chosen: (s: string) => chosenOption(s, settings.chosen)?.id ?? null,
        fileOf: (o: string) => optionById(o)?.file.replace(/^[^/]+\//, "") ?? null,
        fast: false,
        /**
         * A PREVIEW DESCRIBES THE A14B LEG, ALWAYS, AND SAYS SO BY BEING FALSE.
         *
         * This ctx is built by hand rather than shared with POST's, and a field
         * missing here does not fail — it reads as `undefined`, which
         * `buildWanClip` treats as "not small" and silently previews the wrong
         * leg's prompt and negative. Stating it explicitly is the difference
         * between a default and an omission.
         *
         * It is `false` rather than plumbed because `?resolve=` takes no body:
         * the caller cannot ask for a leg, so inventing one would be a preview
         * of a run nobody requested. If the panel ever needs a 5B preview it
         * must pass the flag, and this line is where it lands.
         */
        small: false,
        // Placeholder names. Modes throw without an init and we only ever read
        // strings back out — the graph is discarded, never queued.
        images: { init: "resolve.png", end: "resolve.png", style: "resolve.png", mask: "resolve.png" },
        seed: 0,
      };
      const prompt = mode.prompt(params, ctx);
      // The negative is worth more than the positive on the Wan leg and it is
      // not derivable from the mode alone — it is assembled inside the graph.
      // Build one to read it; a mode that cannot build without a real image
      // simply reports no negative rather than failing the whole lookup.
      let negative: string | undefined;
      try {
        negative = readNegative(mode.build(params, ctx));
      } catch {
        /* no negative for this mode/params — the panel just shows the positive */
      }
      return NextResponse.json({ prompt, negative });
    } catch (e: any) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
  }

  if (!id) {
    // Union of memory and disk: the Map knows live jobs, the disk knows
    // everything that ever finished (job.json survives reloads).
    const all: Record<string, unknown> = {};
    try {
      for (const dir of readdirSync(WORK)) {
        // THE DIRECTORY IS THE AUTHORITY ON FRAMES, not job.json.
        //
        // A job.json is written by two hands: this route (which records
        // `frames`) and cli.mjs (which, until it was fixed, did not). A row
        // with no `frames` renders as a bare line — no thumbnails, no
        // → init / + sheet / re-roll — so an entire CLI-driven move-set
        // showed up in the panel as twelve "done" lines nobody could touch.
        // Listing the PNGs costs one readdir and makes both hands' work,
        // and every older record already on disk, editable.
        const frames = framesOnDisk(dir);
        try {
          const meta = JSON.parse(readFileSync(join(WORK, dir, "job.json"), "utf8"));
          // Disk copies of live states are stale by definition — the Map
          // overwrites survivors below; what remains died in a reload.
          /**
           * IS A RUNNING ROW ACTUALLY ALIVE, OR A CORPSE FROM A RELOAD?
           *
           * This used to answer "no frames yet" with `error: lost in a
           * dev-server reload`, which was right when only the panel wrote
           * job.json — the panel's jobs live in a Map that a reload empties.
           *
           * `cli.mjs` now writes job.json at QUEUE time and heartbeats into it,
           * so a frameless running row is the NORMAL state of a healthy
           * command-line generation for the 6-15 minutes it takes. Condemning
           * those would replace "invisible" with "reported as dead", which is
           * worse: an unattended sweep would show a wall of red while the GPU
           * worked perfectly.
           *
           * The heartbeat is the liveness signal. A CLI run touches job.json at
           * least every few seconds while sampling; nothing touches it after
           * the process dies. Panel-written rows have no heartbeat and keep the
           * old reload verdict, which is still correct for them.
           */
          const beat = typeof meta.heartbeatAt === "number" ? meta.heartbeatAt : null;
          const live = beat !== null && Date.now() - beat < STALE_MS;
          const running = meta.state === "queued" || meta.state === "running";
          all[dir] =
            running && !frames.length && !live
              ? {
                  ...meta,
                  state: "error",
                  error: beat === null
                    ? "lost in a dev-server reload — re-roll it"
                    : `no heartbeat for ${Math.round((Date.now() - beat) / 1000)}s — the run died (check ~/comfy/guard.log)`,
                  frames,
                }
              : { ...meta, ...(meta.state === "running" && frames.length ? { state: "done" } : {}), frames };
        } catch {
          all[dir] = { state: "done", mode: "cli", label: dir, startedAt: 0, frames };
        }
      }
    } catch {
      /* no work dir yet */
    }
    for (const [k, v] of jobs) {
      const { previewB64: _p, ...lean } = v;
      all[k] = lean;
    }
    /**
     * THE SWEEP, which is not a job and has no row of its own.
     *
     * `bench-moveset.mjs` runs 21 generations over several hours and frees the
     * models between each, so for 30-90 seconds per row NOTHING is queued and
     * the jobs list is honestly empty. The operator's read of that was "I have
     * no clue it's running, I have to look at task manager" — correct, because
     * no per-job view can represent a process that is between jobs.
     *
     * Read here rather than from its own route so the panel's existing poll
     * picks it up with no second request.
     */
    let sweep: unknown = null;
    try {
      sweep = JSON.parse(readFileSync(join(WORK, "_sweep.json"), "utf8"));
    } catch {
      /* no sweep has ever run, or the file is mid-write — both are "no sweep" */
    }
    return NextResponse.json({ jobs: all, sweep });
  }
  if (frame) {
    // No traversal: the frame must be a bare .png name that really exists in
    // this job's dir (disk is the authority — the job map dies on dev reload).
    try {
      const ok = /^[\w.-]+\.png$/.test(frame) && /^[\w-]+$/.test(id) && readdirSync(join(WORK, id)).includes(frame);
      if (!ok) return NextResponse.json({ error: "no such frame" }, { status: 404 });
      let buf: Buffer = readFileSync(join(WORK, id, frame));
      // ?w= serves a nearest-neighbour thumbnail: a 56px strip thumb must not
      // cost a 400KB decode ×21 — that is what made the jobs board drop
      // images under load. Full-size stays the default.
      const w = Number(url.searchParams.get("w"));
      if (Number.isFinite(w) && w >= 16 && w <= 1024) {
        try {
          const importMod = new Function("p", "return import(p)");
          const mod = await importMod("canvas");
          const img = await mod.loadImage(buf);
          if (img.width > w) {
            const cv = mod.createCanvas(w, Math.round((img.height / img.width) * w));
            const ctx = cv.getContext("2d");
            ctx.imageSmoothingEnabled = true;
            ctx.drawImage(img, 0, 0, cv.width, cv.height);
            buf = cv.toBuffer("image/png");
          }
        } catch {
          // Fallback to unresized buffer
        }
      }
      // A job's frames never change after it finishes — let the browser keep
      // them instead of refetching megabytes on every poll-driven rerender.
      return new NextResponse(new Uint8Array(buf), {
        headers: { "content-type": "image/png", "cache-control": "public, max-age=86400, immutable" },
      });
    } catch {
      return NextResponse.json({ error: "no such frame" }, { status: 404 });
    }
  }
  if (url.searchParams.get("preview")) {
    const b64 = jobs.get(id)?.previewB64;
    if (!b64) return NextResponse.json({ error: "no preview yet" }, { status: 404 });
    return new NextResponse(new Uint8Array(Buffer.from(b64, "base64")), { headers: { "content-type": "image/jpeg" } });
  }
  const job = jobs.get(id);
  if (!job) {
    // Survive a dev-server reload: job.json + frames on disk rebuild it.
    // A job that was queued/running when the server reloaded is gone for
    // good — its graph lived in memory — so report it honestly.
    try {
      const meta = JSON.parse(readFileSync(join(WORK, id, "job.json"), "utf8"));
      const frames = framesOnDisk(id);
      if ((meta.state === "queued" || meta.state === "running") && !frames.length) {
        return NextResponse.json({ ...meta, state: "error", error: "lost in a dev-server reload — re-roll it", frames });
      }
      return NextResponse.json({ ...meta, ...(meta.state === "running" ? { state: "done" } : {}), frames, note: "recovered from disk" });
    } catch {
      /* fall through */
    }
    try {
      const frames = framesOnDisk(id);
      if (frames.length) return NextResponse.json({ state: "done", frames, note: "recovered from disk" });
    } catch {
      /* genuinely unknown */
    }
    return NextResponse.json({ error: "unknown job" }, { status: 404 });
  }
  const { previewB64: _p, ...lean } = job;
  return NextResponse.json({ ...lean, hasPreview: !!job.previewB64 });
}

export async function DELETE(req: Request) {
  if (!backendPresent()) return NextResponse.json({ error: "no backend on this machine" }, { status: 404 });
  const id = new URL(req.url).searchParams.get("id");
  const job = id ? jobs.get(id) : null;
  if (!id || !job) return NextResponse.json({ error: "unknown job" }, { status: 404 });
  if (job.state === "queued") {
    // Never reached ComfyUI — just unpark it.
    sched.parked = sched.parked.filter((p) => p.id !== id);
    Object.assign(job, { state: "cancelled" });
    persistJob(id);
    return NextResponse.json({ ok: true, how: "unparked" });
  }
  if (job.state !== "running") return NextResponse.json({ error: `job is ${job.state}` }, { status: 400 });
  const settings = loadSettings();
  setComfyUrl(settings.comfyUrl);
  try {
    const how = job.promptId ? await cancelPrompt(job.promptId) : "dequeued";
    Object.assign(job, { state: "cancelled", error: undefined, progress: undefined, previewB64: undefined });
    persistJob(id);
    return NextResponse.json({ ok: true, how });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 502 });
  }
}
