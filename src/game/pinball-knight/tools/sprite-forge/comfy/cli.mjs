#!/usr/bin/env node
/**
 * sprite-forge ↔ ComfyUI driver CLI.
 *
 *   Add --file-as <sheet-name> to ANY run to file it under that creature in
 *   the /forge library (frog, brute, pinball_knight…). Untagged stays unfiled.
 *
 *   node cli.mjs stats
 *   node cli.mjs create  --prompt "a mangy dog monster"      [--canvas WxH] [--seed N]
 *                        [--no-style] [--steps N]        TEXT -> IMAGE, no init
 *   node cli.mjs rotate  --init frame.png --to "left"        [--out DIR] [--seed N]
 *   node cli.mjs edit    --init frame.png --prompt "..."     [--out DIR] [--seed N]
 *                        [--canvas init|WxH]
 *   node cli.mjs animate --init frame.png --action "walking" [--out DIR] [--seed N]
 *                        [--loop] [--end last.png] [--canvas WxH] [--temporal N]
 *                        [--frames 21] [--no-lora] [--tile 128]
 *   node cli.mjs retarget --poses row.png --character idle.png --subject "a spotted frog"
 *   node cli.mjs refile  --dir <folder of PNGs> --file-as brute [--label "..."] [--mode animate]
 *
 * Outputs land in work/comfy/<run-name>/ (gitignored, like every other
 * sprite-forge scratch). What comes back is SOFT high-res art — feed it to
 * prep/ + inbox/ for the real pixel crush; this tool deliberately does not
 * pixelize (one canonical crush, and it lives in sprite-forge proper).
 *
 * Manual tool, not a test: nothing under vitest may ever reach the network.
 */
import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNodes, fetchImage, outputImages, queuePrompt, systemStats, uploadImage, waitFor, watchProgress } from "./client.mjs";
import { controlMap, h3Length, minimaxH3I2V, qwenEdit, qwenText2Image, wanI2V } from "./graphs.mjs";
// The prompt comes from the MODE, not from a second copy here. A CLI that
// restates a mode's prompt is the drift the registry exists to prevent — the
// panel and the CLI already dispatch through this table for that reason.
import { FACINGS, MODES, fastAvailable, smallAvailable } from "./modes.mjs";
import { optionById, chosenOption } from "./manifest.mjs";
import { installState, loadSettings } from "./forge-config.mjs";
// The gate runs HERE, on the raw frames, because this is the only place that
// sees them before anything mattes or crops them — and `ghost.ts` measured its
// own separation collapsing from 95x to 2x once a matte is applied.
import { ghostClip } from "../ghost.ts";
// The companion gate: `ghost` asks whether the frames are clean, `motion` asks
// whether there are frames worth cleaning. A frozen clip passes ghost by
// definition — see motion.ts's header.
import { motionClip } from "../motion.ts";
// The third axis. `ghost` asks if a limb dissolved toward the FIELD, `fade`
// asks if a marking dissolved into the BODY — opposite directions, and ghost is
// blind to this one by construction. Reported on the approved walk by eye.
import { fadeClip } from "../fade.ts";

/**
 * THE SAME `ctx` THE PANEL ROUTE BUILDS — LoRAs, unet choices and all.
 *
 * ── WHAT THIS REPLACES ──────────────────────────────────────────────────────
 *
 * `retarget` used to pass a stub — `has: () => false, lora: () => null,
 * unet: () => null, fast: false` — which is not "no options", it is EVERY
 * option silently off. A CLI run therefore had no `tarn59-pixel-style`, no
 * chosen unet, and no fast bundle, while the identical mode driven from the
 * panel had all three. Two different pictures from one mode id.
 *
 * `animate` was worse: it never reached `MODES` at all. It restated the mode's
 * prompt verbatim (so `preset.avoid` — the "feet sliding along the ground,
 * gliding, ice skating, floating" ban that exists precisely because the frog
 * glided — never applied), hardcoded the pixel LoRA onto BOTH experts (when
 * `wanBundle` puts `pix3lwalk` on the HIGH expert only), and passed no
 * `extraNegative`. The file's own header already said "The prompt comes from
 * the MODE, not from a second copy here."
 *
 * Reads the same `~/comfy/forge-settings.json` the panel writes, so a unet
 * chosen in the UI is honoured on the command line.
 */
function buildCtx({ images = {}, seed = 7, fast = false, small = false, leg = "qwen" } = {}) {
  const settings = loadSettings();
  const has = (optionId) => {
    const o = optionById(optionId);
    return o ? installState(o).state === "installed" : false;
  };
  return {
    has,
    lora: (optionId) => optionById(optionId)?.file.replace(/^loras\//, "") ?? null,
    unet: (slotId) => chosenOption(slotId, settings.chosen)?.file.replace(/^unet\//, "") ?? null,
    chosen: (slotId) => chosenOption(slotId, settings.chosen)?.id ?? null,
    /** Any option's filename by OPTION id — `unet()` takes a SLOT and only does unets. */
    fileOf: (optionId) => optionById(optionId)?.file.replace(/^[^/]+\//, "") ?? null,
    fast: fast && fastAvailable(leg, has),
    // Same gate as `fast`: the caller may ask and the weights decide. The CLI
    // needs this for the same reason the header above gives — a ctx field the
    // panel has and the CLI does not is two different pictures from one mode
    // id, and the small leg is the one that decides whether a run FINISHES.
    small: small && smallAvailable(leg, has),
    images,
    seed,
  };
}

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The clip names the animator packs — READ from `labels.ts`, not restated.
 *
 * `KNOWN_CLIPS` there is typed `ReadonlySet<ClipName>` precisely so a wrong
 * name is a compile error, and its own docblock records what a hand-mirror
 * cost last time (`hurt` for `stumble`, an actor silently missing its
 * stagger). A second copy in this file would be that mirror again, one level
 * out and beyond tsc's reach. `published.test.ts` reads `IMPORTED_ART` out of
 * `boot/sheets.ts` the same way and for the same reason.
 */
const CLIP_NAMES = (() => {
  const src = readFileSync(join(HERE, "..", "labels.ts"), "utf8");
  const block = /KNOWN_CLIPS[^=]*=\s*new Set<ClipName>\(\[([\s\S]*?)\]\)/.exec(src);
  if (!block) throw new Error("[forge] could not find KNOWN_CLIPS in labels.ts");
  return [...block[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
})();
const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name, fallback = undefined) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

/**
 * A canvas with the REFERENCE ROW's aspect, at roughly the model's trained area.
 *
 * PNG dimensions come from the IHDR at a fixed offset — no image library, and
 * this file is a manual driver that must not grow a dependency for one header.
 * Snapped to /16 because the latent is 1/8 and an odd size gets padded, which
 * shifts the row off the canvas edge it is supposed to fill.
 */
function canvasFor(pngPath) {
  const buf = readFileSync(pngPath);
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  const area = 1344 * 768;
  const s = Math.sqrt(area / (w * h));
  const snap = (v) => Math.max(256, Math.round((v * s) / 16) * 16);
  return { width: snap(w), height: snap(h) };
}

function outDir(kind) {
  const dir = opt("out", join(HERE, "..", "work", "comfy", `${kind}-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Every run writes a `job.json` beside its frames, exactly like the panel's
 * own jobs do.
 *
 * Without it a CLI generation is INVISIBLE in /forge: the library route scans
 * `work/comfy/*` and skips any directory whose job.json is missing or carries
 * no `character` ("CLI runs have no job.json — they stay unfiled"). So work
 * done here could never be viewed, re-rolled or cut into a sheet through the
 * panel — the two halves of the forge could not see each other.
 *
 * `--character <sheet-name>` is what files it. Untagged runs still write the
 * record (so the frames survive and the mode/label are recoverable) and still
 * stay unfiled, which is the honest state for a generation that belongs to no
 * creature yet.
 *
 * THE RECORD MUST CARRY `frames`, `params` AND `clip` — they are what make the
 * panel's job card an editing surface rather than a receipt. Frames draw the
 * thumbnails (and with them → init / + sheet / ✎ fix), params arm ↻ re-roll,
 * and clip pre-labels the row the tray files these frames under. A twelve-clip
 * move-set generated here once landed in /forge as twelve untouchable "done"
 * lines because this object held none of the three. (The generate route now
 * also reads the directory for frames, so older records self-heal; writing
 * them is still what keeps job.json a complete record on its own.)
 */
/**
 * "fetch failed" IS NOT A DIAGNOSIS, and it has now cost three sessions.
 *
 * When the guard stops ComfyUI, every call in `client.mjs` fails with node's
 * bare `TypeError: fetch failed`. That string has been read as a model problem,
 * a settings problem and a network problem on three separate occasions; it has
 * never once been any of those. It means the backend is not there.
 *
 * The guard hard-strikes on sustained WSL pressure, and it tends to do so
 * SECONDS AFTER a Wan run finishes — 39s after the 08-07 walk, 45s after the
 * decode A/B. So the failure lands on the NEXT run, and the run that caused it
 * looks like the healthy one. Naming that here is the difference between "the
 * backend is down, restart it" and another session spent theorising.
 */
async function requireBackend() {
  try {
    await systemStats();
  } catch (err) {
    throw new Error(
      `ComfyUI is not answering on 127.0.0.1:8188 (${err.message}).\n` +
      `  This is almost always the RAM guard having stopped it — a HARD strike often lands\n` +
      `  seconds AFTER a Wan run finishes, so the previous run looks fine and this one dies.\n` +
      `  Check:   tail -5 ~/comfy/guard.log\n` +
      `  Restart: ~/comfy/run.sh -d`,
    );
  }
}

/** The last few lines of the guard's own log — it names the cause in one line. */
function guardTail(n = 4) {
  try {
    const lines = readFileSync(join(homedir(), "comfy", "guard.log"), "utf8").trimEnd().split("\n");
    return lines.slice(-n).map((l) => `    ${l}`).join("\n");
  } catch {
    return "    (no ~/comfy/guard.log)";
  }
}

/**
 * Turn a mid-run disconnect into the diagnosis instead of `fetch failed`.
 *
 * `requireBackend` covers the server being down when we start. The case that
 * actually costs runs is the server dying DURING one: the job queues fine, the
 * poll throws a bare `TypeError: fetch failed`, and the log says nothing about
 * why. Measured 2026-08-07 — two runs lost to a HARD strike on HOST pressure
 * (Windows at 61.7GB with 118 chrome processes holding 9.9GB of it), which is
 * not visible from inside WSL at all: `free` showed 26GB available the whole
 * time. Without the guard log quoted here that looks like a code fault.
 */
async function diagnose(err) {
  const msg = err?.message ?? "";
  const dropped = /fetch failed|ECONNREFUSED|socket hang up/i.test(msg);
  // `execution failed:\n[]` — status "error" with NO execution_error message.
  // A real node failure names the node; an empty list is the signature of an
  // INTERRUPT, and the only thing that interrupts jobs here is the RAM guard.
  // This is the exact string that has been read as a model or settings fault.
  const interrupted = /execution failed:\s*\n?\s*\[\s*\]/.test(msg);
  if (!dropped && !interrupted) return err;
  let alive = true;
  try { await systemStats(); } catch { alive = false; }
  const what = interrupted
    ? "ComfyUI reported an error with no failing node — that is an INTERRUPT, not a bad graph"
    : `ComfyUI ${alive ? "is answering again but dropped this job" : "went away mid-run"}`;
  return new Error(
    `${msg}\n  ${what}.\n` +
    `  The RAM guard is the usual cause, and it strikes on HOST pressure too, which\n` +
    `  \`free\` inside WSL cannot see — 2026-08-07 lost two runs to Windows sitting at\n` +
    `  61.7GB while WSL reported 26GB free. Last guard lines:\n${guardTail()}\n` +
    `  ${alive ? "Backend is up; free host RAM before retrying." : "Restart: ~/comfy/run.sh -d"}`,
  );
}

async function run(graph, dir, meta = {}) {
  await requireBackend();
  await assertNodes(graph);
  const t0 = Date.now();
  const clientId = `cli-${Math.random().toString(36).slice(2, 10)}`;
  const id = await queuePrompt(graph, { clientId });
  console.log(`queued ${id}`);

  /**
   * ── THE RUN ANNOUNCES ITSELF NOW, NOT WHEN IT FINISHES ────────────────────
   *
   * `job.json` used to be written once, at the end. For the 6-15 minutes a Wan
   * run actually takes, the panel therefore saw a directory with no job.json
   * and no frames — and `/api/comfy/generate` renders exactly that as
   * `{ state: "done", mode: "cli", frames: [] }`. A live generation appeared in
   * /forge as a FINISHED row with nothing in it, while the header counted
   * "0 running · 0 queued" because that counter only knows jobs the panel
   * itself submitted.
   *
   * So an unattended sweep — which is the whole point of `bench-moveset.mjs` —
   * was indistinguishable from a broken one. The operator's question was
   * literally "so is it generating?", and nothing on the page could answer it.
   *
   * The fix is that the file is the transport: write it at QUEUE time with
   * `state: "running"`, then heartbeat progress into it. No websocket for the
   * panel to hold, no second source of truth, and it survives a dev-server
   * reload because it was never in memory.
   */
  const beat = (extra = {}) => {
    try {
      writeFileSync(
        join(dir, "job.json"),
        JSON.stringify({ source: "cli", state: "running", startedAt: t0, promptId: id, heartbeatAt: Date.now(), ...meta, ...extra }, null, 1),
      );
    } catch {
      /* a heartbeat must never take the run down */
    }
  };
  beat();
  // Advisory only — `waitFor`/history stays the authority on done and error,
  // because ComfyUI's progress traffic is documented to trail completion
  // (#9330). This drives a progress bar and nothing else.
  let last = 0;
  const stopWatch = watchProgress(id, clientId, {
    onProgress: (p) => {
      // Throttled: a 20-step sampler at 640² fires often, and this is a file
      // write that the panel polls at its own pace.
      if (Date.now() - last < 1500) return;
      last = Date.now();
      beat({ progress: { node: p.node ?? null, value: p.value ?? 0, max: p.max ?? 1 } });
    },
  });

  let history, images;
  try {
    history = await waitFor(id);
    images = outputImages(history);
  } catch (err) {
    try {
      writeFileSync(join(dir, "job.json"), JSON.stringify({ source: "cli", state: "error", startedAt: t0, promptId: id, error: String(err?.message ?? err).slice(0, 400), ...meta }, null, 1));
    } catch { /* the throw below is what matters */ }
    throw await diagnose(err);
  } finally {
    stopWatch();
  }
  const took = ((Date.now() - t0) / 1000).toFixed(1);
  const frames = [];
  for (const im of images) {
    const buf = await fetchImage(im);
    const name = im.filename.replace(/.*\//, "");
    writeFileSync(join(dir, name), buf);
    frames.push(name);
  }
  // ── A RUN THAT PRODUCED NOTHING IS A FAILED RUN ──────────────────────────
  //
  // ComfyUI answers a guard-interrupted job with HTTP 200 and an empty output
  // list, so this used to write `state: "done"` with `frames: []` and exit 0.
  // `build-character.mjs` fires 18 of these unattended; every one of them could
  // report success having produced nothing, which is the exact failure mode a
  // green exit code is supposed to rule out. Read `~/comfy/guard.log` when this
  // throws — a SOFT strike writes no `guard-tripped.json` and the log is the
  // only place the cause is named.
  if (frames.length === 0) {
    writeFileSync(
      join(dir, "job.json"),
      JSON.stringify({ source: "cli", state: "failed", startedAt: t0, tookS: Math.round(Number(took)), promptId: id, frames: [], ...meta }, null, 1),
    );
    throw new Error(
      `no frames after ${took}s — the backend returned an empty output. ` +
      `Check ~/comfy/guard.log for a SOFT/HARD strike (it writes no guard-tripped.json on SOFT).`,
    );
  }

  // ── THE GHOST GATE ───────────────────────────────────────────────────────
  //
  // Advisory here, on purpose: the frames are already paid for and dropping
  // them is a curation decision, not a reason to throw away 435 seconds of
  // GPU. What this MUST do is refuse to be silent, so the record carries the
  // per-frame numbers and the panel can exclude the bad cells by default.
  let ghost = null;
  let motion = null;
  let fade = null;
  if (frames.length > 1) {
    const cells = [];
    try {
      for (const name of frames) cells.push(await rawPng(join(dir, name)));
    } catch (err) {
      console.warn(`gates skipped — could not decode the frames: ${err.message}`);
    }
    if (cells.length > 1) {
      try {
        const v = ghostClip(cells, { label: meta.label ?? "clip" });
        ghost = { pct: v.pct.map((p) => Number((p * 100).toFixed(2))), flagged: v.flagged, soft: v.soft, level: v.level };
        if (v.flagged.length || v.soft.length) console.log(v.report);
      } catch (err) {
        // A scoring failure must not lose the frames. Say so and move on.
        console.warn(`ghost gate skipped: ${err.message}`);
      }
      // ── THE MOTION GATE ──────────────────────────────────────────────────
      //
      // NOT advisory in the same way. A ghosted frame is a frame to drop; a
      // FROZEN CLIP is 370 seconds of GPU that produced a still photograph,
      // and it has shipped past every automated check twice — the 08-08
      // `idle4` scored 0.09% ghost and reported `level: "ready"` while
      // measuring 0.2% churn against the approved walk's 23.7%. Ghosting
      // cannot see this: a clip that does not move has nothing to smear.
      //
      // So this one SHOUTS. It still does not throw — the frames are paid for
      // and the operator may want to look — but a freeze must never scroll
      // past as a success line.
      try {
        const v = motionClip(cells, { label: meta.label ?? "clip" });
        motion = {
          churn: v.churn.map((p) => Number((p * 100).toFixed(2))),
          seam: Number((v.seam * 100).toFixed(2)),
          boxes: v.boxes,
          // The scale gate's NUMBER, not just its verdict. Added with the gate
          // and forgotten here, which is the same omission `fade` had: a check
          // whose magnitude lives only in the printed report cannot rank
          // twenty clips, and the report is not kept.
          scaleSwing: Number((v.scaleSwing * 100).toFixed(2)),
          scaleTrend: Number((v.scaleTrend * 100).toFixed(3)),
          level: v.level,
        };
        if (v.level !== "ready") console.log(v.report);
        if (v.level === "reject") {
          console.log(
            "\n  ⚠️  FROZEN CLIP — this is a FAILED GENERATION, not a curation problem.\n" +
              "      Do not cut frames out of it. Regenerate; for a subtle clip drop --loop first.\n",
          );
        }
      } catch (err) {
        console.warn(`motion gate skipped: ${err.message}`);
      }
      // ── THE FADE GATE ────────────────────────────────────────────────────
      //
      // Advisory like ghost: the named frames are droppable and the clip is
      // paid for. It exists because the operator saw the dog's tan paws blink
      // out on the APPROVED walk — a clip that had passed everything.
      try {
        const v = fadeClip(cells, { label: meta.label ?? "clip" });
        fade = { palette: v.palette, flagged: v.flagged, level: v.level, worst: v.worst };
        if (v.level !== "ready") console.log(v.report);
      } catch (err) {
        console.warn(`fade gate skipped: ${err.message}`);
      }
    }
  }

  // NB: `--file-as`, not `--character` — `retarget` already owns that flag
  // for its character IMAGE, and filing a run under a .png path would put
  // a junk row in the library.
  const character = opt("file-as");
  writeFileSync(
    join(dir, "job.json"),
    JSON.stringify(
      {
        source: "cli",
        state: "done",
        startedAt: t0,
        tookS: Math.round(Number(took)),
        promptId: id,
        frames: frames.sort(),
        ...meta,
        ...(character ? { character } : {}),
        ...(ghost ? { ghost } : {}),
        ...(motion ? { motion } : {}),
        ...(fade ? { fade } : {}),
      },
      null,
      1,
    ),
  );
  console.log(`${images.length} frame(s) in ${took}s -> ${dir}${character ? `  (filed under ${character})` : ""}`);
  return { images, took };
}

/** Decode a PNG to the `RawImage` the pure QA modules take. */
async function rawPng(path) {
  const { loadImage, createCanvas } = await import("canvas");
  const img = await loadImage(path);
  const c = createCanvas(img.width, img.height);
  c.getContext("2d").drawImage(img, 0, 0);
  const d = c.getContext("2d").getImageData(0, 0, img.width, img.height);
  return { width: img.width, height: img.height, data: d.data };
}

const main = {
  async stats() {
    const s = await systemStats();
    const d = s.devices?.[0] ?? {};
    console.log(`comfyui ${s.system?.comfyui_version} on ${d.name}`);
    console.log(`vram free ${(d.vram_free / 2 ** 30).toFixed(1)} / ${(d.vram_total / 2 ** 30).toFixed(1)} GiB`);
  },

  /**
   * Identity-preserving rotation via the edit model.
   *
   * ── THIS DISPATCHES THROUGH `MODES`, AND IT DID NOT USED TO ─────────────────
   *
   * It restated the mode's prompt verbatim and called `qwenEdit` with nothing
   * but an image and a seed — the exact defect this file's header names, and
   * which `animate` and `retarget` were already fixed for. Three things were
   * silently off on every command-line rotation:
   *
   *   - `fal-multi-angle`, ON DISK AND WIRED INTO THE MODE. With it the prompt
   *     is the LoRA's trained grammar (`<sks> right side view eye-level shot
   *     medium shot`, 96 poses); without it, freeform "Turn the character to
   *     face …", which is the weaker path the LoRA was installed to replace.
   *   - the rest of `qwenBundle` — the pixel style lock and the Lightning
   *     speed LoRA.
   *   - the unet chosen in the panel (`rot-unet`).
   *
   * Chapter 11's work order opens with two `cli.mjs rotate` calls to build the
   * S and N masters, so every facing this creature was about to get would have
   * come off the un-LoRA'd path — and identity drift across facings is the one
   * failure the multi-angle LoRA is there to prevent.
   *
   * `--to` takes a facing ID (`E`/`S`/`N`, or a diagonal — see FACINGS) and
   * resolves to that row's trained azimuth token. Anything else is passed
   * through as a custom angle, which is how an untrained phrase still works
   * while a known facing can never be spelled wrong.
   */
  async rotate() {
    const init = opt("init");
    const to = opt("to");
    if (!init || !to) throw new Error(`rotate needs --init <png> and --to <${FACINGS.map((f) => f.id).join("|")}|any angle>`);
    const dir = outDir(`rotate-${to.replace(/\s+/g, "_")}`);
    const image = await uploadImage(init, basename(init));
    const mode = MODES.find((m) => m.id === "rotate");
    // An exact ID is a known facing; anything else is a freeform angle. Matched
    // case-insensitively so `--to s` cannot quietly become a custom string.
    const known = FACINGS.find((f) => f.id.toLowerCase() === String(to).toLowerCase());
    const params = known ? { facing: known.id } : { facing: "custom", custom: to };
    const ctx = buildCtx({ images: { init: image }, seed: Number(opt("seed", 7)), fast: has("fast"), leg: "qwen" });
    // Say which grammar actually ran, never which was asked for — the same
    // reason `animate` prints its leg. An absent LoRA is a silent downgrade.
    console.log(
      ctx.has("fal-multi-angle")
        ? `angles: fal-multi-angle LoRA @0.9 — trained grammar${known ? ` (${known.id} → "${known.sks}")` : ""}`
        : "angles: NO multi-angle LoRA installed — freeform turning, expect identity drift across facings",
    );
    console.log(`prompt: ${mode.prompt(params, ctx)}`);
    await run(mode.build(params, ctx), dir, {
      mode: "rotate",
      label: `rotate → ${to}`,
      params,
      resolvedPrompt: mode.prompt(params, ctx),
      seed: Number(opt("seed", 7)),
    });
  },

  /**
   * Free-form instruction edit — inpaint-class fixes, pose keyframes.
   *
   * `--canvas init` derives the output canvas from the init's own aspect.
   * Editing a 4-pose ROW on the square default returns a GRID, for the same
   * reason `retarget` documents: the canvas aspect dictates the layout, and it
   * outranks the sentence. Left opt-in so a plain single-figure edit keeps the
   * square it has always had.
   */
  /**
   * TEXT → IMAGE. The master, from nothing.
   *
   * Every other command here starts from a picture somebody else made — a
   * photo, a painter's render, another game's sprite. This is step 1 of
   * docs/PLAN_KEYFRAME_PIPELINE.md, and it is what makes the rest of that plan
   * mean anything: once the master is ours, every keyframe and in-between
   * downstream is conditioned on art this pipeline produced at the size it
   * ships at.
   *
   * The style LoRAs are doing more work here than anywhere else in the forge —
   * there is no init to inherit a look from, so `tarn59-pixel-style` IS the
   * style decision. `--no-style` turns it off to see what the base model does
   * unaided, which is the A/B worth having before trusting any of this.
   *
   *   node cli.mjs create --prompt "a mangy dog monster, side view" --file-as dog
   *   node cli.mjs create --prompt "..." --canvas 768x1024 --seed 3
   */
  async create() {
    const prompt = opt("prompt");
    if (!prompt) throw new Error("create needs --prompt <description>");
    const dir = outDir("create");
    const canvas = opt("canvas", "1024x1024");
    const [width, height] = canvas.split("x").map(Number);
    if (!width || !height) throw new Error(`--canvas takes WxH, got "${canvas}"`);
    const ctx = buildCtx({ images: {}, seed: Number(opt("seed", 7)), fast: has("fast"), leg: "qwen" });
    // Same resolution path the panel uses, so a CLI master and a panel master
    // are the same picture — the drift this file's header exists to prevent.
    const loras = has("no-style") || !ctx.has("tarn59-pixel-style")
      ? []
      : [{ name: ctx.lora("tarn59-pixel-style"), strength: 0.8 }];
    const seed = Number(opt("seed", 7));
    console.log(`create ${width}x${height} seed ${seed}${loras.length ? " + pixel style lock" : " (NO style lora)"}`);
    await run(
      qwenText2Image({ prompt, width, height, seed, steps: Number(opt("steps", 20)), loras }),
      dir,
      { mode: "create", label: "create", params: { prompt }, resolvedPrompt: prompt, seed },
    );
  },

  async edit() {
    const init = opt("init");
    const prompt = opt("prompt");
    if (!init || !prompt) throw new Error("edit needs --init <png> and --prompt <instruction>");
    const dir = outDir("edit");
    const image = await uploadImage(init, basename(init));
    const canvas = opt("canvas");
    let size = {};
    if (canvas === "init") {
      size = canvasFor(init);
      console.log(`canvas ${size.width}x${size.height} from the init's aspect`);
    } else if (canvas) {
      const [w, h] = canvas.split("x").map(Number);
      if (!w || !h) throw new Error(`--canvas takes "init" or WxH, got "${canvas}"`);
      size = { width: w, height: h };
    }
    // `--ref` rides along as Figure 2. With `--denoise` it is the other half of
    // the split: the LATENT carries structure (pose, facing, layout) and the
    // reference carries identity (who this creature is). Neither alone does
    // both — that is the whole measurement in docs/POSE_IS_THE_LATENT.md.
    const ref = opt("ref");
    const image2 = ref ? await uploadImage(ref, basename(ref)) : null;
    await run(
      qwenEdit({ image, image2, prompt, seed: Number(opt("seed", 7)), denoise: Number(opt("denoise", 1)), ...size }),
      dir,
      { mode: "edit", label: `edit${ref ? " + ref" : ""}`, params: { prompt }, resolvedPrompt: prompt, seed: Number(opt("seed", 7)) },
    );
  },

  /**
   * SHOW the poses instead of describing them.
   *
   * `keyframes` names its four poses in a sentence, and four poses sharing one
   * denoising pass regress toward each other — every row so far came back
   * 97-99% identical. A pose ROW from the reference library does not have that
   * problem: an animator drew those poses to be different, so the diversity is
   * in the pixels rather than in an adjective.
   *
   *   node cli.mjs retarget --poses .poses/mario/walk/E/row.png \
   *                         --character frog-idle.png --subject "a spotted frog"
   */
  async retarget() {
    const poses = opt("poses");
    const character = opt("character");
    const subject = opt("subject");
    if (!poses || !character || !subject) {
      throw new Error("retarget needs --poses <row.png> --character <idle.png> --subject <what it is>");
    }
    const dir = outDir("retarget");
    // Figure 1 is the pose row, Figure 2 is the character. qwenEdit feeds them
    // in that order, and the prompt names them the same way — swap either and
    // the model redraws the reference instead of the character.
    const image = await uploadImage(poses, basename(poses));
    const image2 = await uploadImage(character, basename(character));
    const mode = MODES.find((m) => m.id === "retarget");
    // The canvas takes the REFERENCE ROW's aspect. Asking for a 3-wide row on a
    // square canvas returned a 3x3 grid — see the note in the mode's build().
    const { width, height } = canvasFor(poses);
    // Through the real ctx, not a stub. `has: () => false` is not "no options",
    // it is every option silently off — so this ran without the pixel-style
    // LoRA and without the chosen unet while the panel's identical mode had
    // both, and the two produced different pictures from one mode id.
    const graph = mode.build(
      { subject, width, height },
      buildCtx({ images: { init: image, style: image2 }, seed: Number(opt("seed", 7)), fast: has("fast"), leg: "qwen" }),
    );
    console.log(`canvas ${width}x${height} from the reference row`);
    await run(graph, dir, { mode: "retarget", label: `retarget → ${subject}` });
  },

  /**
   * Render a control map and STOP, so it can be looked at before any sampling
   * is paid for.
   *
   *   node cli.mjs posemap --init posed.png [--type openpose|canny|lineart|depth]
   *
   * An openpose pass that finds no skeleton returns a BLACK frame. ControlNet
   * then conditions on nothing, the output is indistinguishable from "this
   * mechanism does not help", and a working lever gets abandoned on the
   * strength of a failed detection. Look at the map first.
   */
  async posemap() {
    const init = opt("init");
    if (!init) throw new Error("posemap needs --init <png>");
    const type = opt("type", "openpose");
    const dir = outDir(`controlmap-${type}`);
    const image = await uploadImage(init, basename(init));
    await run(controlMap({ image, type, resolution: Number(opt("resolution", 1024)) }), dir, {
      mode: "controlmap",
      label: `control map · ${type}`,
    });
  },

  /**
   * A posed frame in, the SAME creature in that pose out — the ControlNet leg.
   *
   *   node cli.mjs pose --init master.png --control posed.png \
   *                     --prompt "..." [--type openpose] [--strength 0.8]
   *
   * `--init` is the IDENTITY (who this creature is, as conditioning) and
   * `--control` is the STRUCTURE (where the limbs go, bound to the sampler).
   * Those are two different slots on purpose: handing a pose in as the init is
   * the thing POSE_IS_THE_LATENT.md measured failing six ways.
   */
  async pose() {
    const init = opt("init");
    const controlPath = opt("control");
    if (!init || !controlPath) throw new Error("pose needs --init <identity png> and --control <posed png>");
    const type = opt("type", "openpose");
    const dir = outDir(`pose-${type}`);
    const image = await uploadImage(init, basename(init));
    const control = await uploadImage(controlPath, basename(controlPath));
    const prompt = opt("prompt") ?? "The same character in the pose shown, full body, pixel art, plain white background.";
    await run(
      qwenEdit({
        image,
        prompt,
        control,
        controlType: type,
        controlStrength: Number(opt("strength", 0.8)),
        controlEnd: Number(opt("end", 0.8)),
        seed: Number(opt("seed", 7)),
        denoise: Number(opt("denoise", 1)),
      }),
      dir,
      { mode: "pose", label: `pose · ${type} @ ${opt("strength", "0.8")}` },
    );
  },

  /**
   * File EXISTING frames as a done job, so /forge can see work that was made
   * before `--file-as` existed (or outside the CLI entirely).
   *
   * The brute is the motivating case: its Wan picks and prepped cells were
   * built before runs wrote job.json, so the jobs board and the library's
   * "recent" strip could never show them — the `--file-as` fix only covered
   * runs that had not happened yet. This is the migration half that was
   * missing. Copies rather than moves: the source directory stays what it
   * was (a sources drop stays tracked, a prep dir stays a prep dir).
   */
  async refile() {
    const src = opt("dir");
    const character = opt("file-as");
    if (!src || !character) throw new Error("refile needs --dir <folder of PNGs> and --file-as <sheet-name>");
    const all = readdirSync(src).filter((f) => f.endsWith(".png")).sort();
    if (!all.length) throw new Error(`no PNGs in ${src}`);
    const mode = opt("mode", "cli");
    const baseLabel = opt("label", `refiled · ${basename(src)}`);

    // ── ONE JOB PER CLIP, NOT ONE JOB PER DIRECTORY ──────────────────────────
    //
    // A job card carries ONE clip selector, and the board defaults it to `idle`
    // for anything that is not an `animate` run (JobsBoard.tsx `clipGuess`). So
    // filing a prep directory as a single job labelled every frame in it `idle`
    // — and a prep directory is exactly where the clips are already SEPARATE:
    // `S-idle0.png`, `S-walk2.png`, `S-death4.png`. The card then showed a
    // death sprawl playing under the word "idle", which is worse than not
    // showing it, because it reads as a generated result rather than a
    // mislabel.
    //
    // The clip token is taken from the filename against CLIP_NAMES, and a
    // directory with no recognisable tokens stays ONE untagged job — the
    // honest answer for a folder of loose frames, rather than guessing.
    const clipOf = (f) => CLIP_NAMES.find((c) => new RegExp(`(^|[^a-z])${c}(\\d|[^a-z]|$)`, "i").test(f)) ?? null;
    const groups = new Map();
    for (const f of all) {
      const c = clipOf(f);
      const key = c ?? "";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(f);
    }
    // A single unlabelled group is the no-clip-tokens case: file it as one job.
    const tagged = [...groups.keys()].some(Boolean);
    const plan = tagged ? [...groups] : [["", all]];

    for (const [clip, frames] of plan) {
      const suffix = clip ? `-${clip}` : "";
      const dir = outDir(`refile-${character}${suffix}-${basename(src).replace(/[^\w-]/g, "_")}`);
      for (const f of frames) copyFileSync(join(src, f), join(dir, f));
      // The earliest source mtime, so the jobs board sorts this where the work
      // actually happened rather than pretending it was made just now.
      const startedAt = Math.min(...frames.map((f) => Math.round(statSync(join(src, f)).mtimeMs)));
      writeFileSync(
        join(dir, "job.json"),
        JSON.stringify(
          {
            source: "refile",
            state: "done",
            mode,
            label: `${baseLabel}${clip ? ` · ${clip}` : ""}`.slice(0, 60),
            startedAt,
            character,
            ...(clip ? { clip } : {}),
            frames,
          },
          null,
          1,
        ),
      );
      console.log(`${frames.length} frame(s)${clip ? ` as ${clip}` : ""} filed under ${character} -> ${dir}`);
    }
  },

  /** Move-set clip from one frame; frames come back as separate PNGs. */
  /**
   * One motion clip, through the MODE — not through a copy of it.
   *
   *   node cli.mjs animate --init master.png --preset walk [--frames 33]
   *   node cli.mjs animate --init master.png --action "hopping forward"
   *   node cli.mjs animate --init midstride.png --preset walk4 --loop   <- a closed cycle
   *
   * `--preset` is what you almost always want: it carries the pose wording the
   * mode has already been tuned with, AND the per-clip `avoid` negative. The
   * walk preset's ban on "feet sliding along the ground, gliding, ice skating,
   * floating, shuffling, legs merging" is the whole reason the frog stopped
   * gliding; the old hand-copied prompt in this file never applied it.
   *
   * `--action` still works and overrides the preset's wording, which is what
   * the mode's own `action` field does.
   */
  async animate() {
    const init = opt("init");
    const preset = opt("preset", "walk");
    const action = opt("action");
    if (!init) throw new Error("animate needs --init <png> [--preset walk|run|attack|death|idle|stumble|defend] [--action ...] [--small]");
    const label = action || preset;
    const dir = outDir(`animate-${String(label).replace(/\s+/g, "_")}`);
    const image = await uploadImage(init, basename(init));
    const mode = MODES.find((m) => m.id === "animate");
    const params = { preset, action: action ?? "", frames: opt("frames", "21") };
    /**
     * `--loop` closes the cycle: the same frame is pinned as first AND last, so
     * the clip is one period of the gait and frame N leads back into frame 1.
     * `--end <png>` pins a different last frame, which is the in-betweening
     * shape (`inbetween` mode) reached from here.
     *
     * Give `--loop` a MID-STRIDE init, not the standing master — pinning a
     * standing pose at both ends animates stand → walk → stand.
     */
    const endPath = opt("end");
    const end = endPath ? await uploadImage(endPath, basename(endPath)) : has("loop") ? image : undefined;
    const ctx = buildCtx({
      images: { init: image, ...(end ? { end } : {}) },
      seed: Number(opt("seed", 7)),
      fast: has("fast"),
      // --small: TI2V-5B, ~13.6GB of reads instead of ~31. Silently a no-op if
      // the weights are not installed, which is what smallAvailable() decides —
      // and the banner below says which leg actually ran, never which was asked
      // for, because that difference is the whole failure mode of a flag.
      small: has("small"),
      leg: "wan",
    });
    console.log(ctx.small
      ? "leg: TI2V-5B (small) — one dense model, NO pixel LoRAs (none exist for 5B)"
      : "leg: I2V-A14B (two experts) — ~31GB of reads; --small halves the RAM if the 5B weights are installed");
    // `--no-lora` is kept: it is how the pixel adapter gets A/B'd, and commit
    // 55f78f9's measurement (pix3lwalk drove the background black and produced
    // 0/21 usable frames) is exactly the run it exists for.
    if (has("no-lora")) ctx.has = () => false;
    const graph = mode.build(params, ctx);
    // Post-build patches, same idiom `--tile` already used: the mode owns the
    // prompt and the LoRA stack, these are the decode/canvas knobs an A/B needs
    // to vary without inventing a second prompt path.
    if (opt("tile")) graph.dec.inputs.tile_size = Number(opt("tile"));
    // One window for the whole clip is now the DEFAULT — this flag is how you
    // go back to a windowed decode on a box too loaded to afford it, and it
    // reintroduces the cross-fade seams `ghost.ts` flags. It is a headroom
    // trade with a measured cost in ruined frames, not a tuning knob. See
    // graphs.mjs's `dec` note and docs/PLAN_DOG_WALK.md §1.
    if (opt("temporal")) {
      graph.dec.inputs.temporal_size = Number(opt("temporal"));
      graph.dec.inputs.temporal_overlap = Number(opt("temporal-overlap", "4"));
    }
    if (opt("canvas")) {
      const [w, h] = String(opt("canvas")).split("x").map(Number);
      if (!w || !h) throw new Error(`--canvas takes WxH, got "${opt("canvas")}"`);
      graph.i2v.inputs.width = w;
      graph.i2v.inputs.height = h;
    }
    console.log(`prompt: ${mode.prompt(params, ctx)}`);
    await run(graph, dir, {
      mode: "animate",
      label: `animate · ${label}`.slice(0, 60),
      params,
      // The preset's declared clip — the panel's tray dropdown reads it, and a
      // `custom` action declares none, which is the honest "— pick a clip —".
      clip: mode.presets?.find((p) => p.id === preset)?.clip || undefined,
      resolvedPrompt: mode.prompt(params, ctx),
      seed: Number(opt("seed", 7)),
    });
  },

  /**
   * THE H3 ARM — the same clip through MiniMax H3 instead of Wan (chapter 14).
   *
   * It shares `animate`'s prompt deliberately. Chapter 14 Phase 2 compares two
   * MODELS, and a comparison that also varies the sentence measures neither;
   * the prompt therefore comes from the same `MODES` entry, through the same
   * `buildCtx`, and the only difference between the arms is the graph.
   *
   * ── WHAT PHASE 1 IS ACTUALLY MEASURING ──────────────────────────────────
   *
   * Peak resident, not wall-clock. Wan A14B dies at the VAE decode with WSL
   * available at 0.7GiB because BOTH experts are still resident; the H3 thesis
   * is that one model can free its encoder first and never get there. So this
   * command samples `MemAvailable` throughout and prints the MINIMUM, which is
   * the number chapter 14's kill criterion is written against (below 3GiB and
   * the run is dead on a busy desktop even if it completes once).
   *
   * It also prints ComfyUI's own load/unload lines from the run's slice of
   * comfy.log, because "did the encoder free before the unet loaded" is the
   * assumption the whole plan rests on and it is not inferable from the RAM
   * trace alone — a low peak could equally mean the encoder never loaded.
   *
   *   node cli.mjs h3 --init <master.png> --preset attack --frames 5 --file-as dog
   */
  async h3() {
    const init = opt("init");
    const preset = opt("preset", "walk");
    const action = opt("action");
    if (!init) throw new Error("h3 needs --init <png> [--preset ...] [--frames 5|22] [--canvas WxH] [--end <png>]");
    const label = action || preset;
    const dir = outDir(`h3-${String(label).replace(/\s+/g, "_")}`);
    const image = await uploadImage(init, basename(init));
    const mode = MODES.find((m) => m.id === "animate");
    // H3 snaps a bad length UP silently, so a run asked for 21 would quietly
    // return 22 and a frame-count comparison against Wan would be off by one
    // without saying so. Resolve it here and print it.
    const asked = Number(opt("frames", "5"));
    const frames = h3Length(asked);
    if (frames !== asked) console.log(`frames: ${asked} is off H3's 17k+5 grid — using ${frames}`);
    const params = { preset, action: action ?? "", frames: String(frames) };
    const endPath = opt("end");
    const end = endPath ? await uploadImage(endPath, basename(endPath)) : has("loop") ? image : undefined;
    const ctx = buildCtx({ images: { init: image, ...(end ? { end } : {}) }, seed: Number(opt("seed", 7)), leg: "wan" });
    const [width, height] = String(opt("canvas", "576x576")).split("x").map(Number);
    if (!width || !height) throw new Error(`--canvas takes WxH, got "${opt("canvas")}"`);
    const prompt = mode.prompt(params, ctx);
    const graph = minimaxH3I2V({
      image, endImage: end, prompt, width, height, length: frames,
      seed: Number(opt("seed", 7)), steps: Number(opt("steps", "20")),
      tiled: !has("no-tiled"),
      tileSize: Number(opt("tile-size", "512")),
      overlap: Number(opt("overlap", "32")),
      temporalOverlap: Number(opt("temporal-overlap", "8")),
      temporalSize: opt("temporal-size") ? Number(opt("temporal-size")) : null,
    });
    console.log(`leg: MiniMax H3 fl2va Q3_K_M — ${width}x${height}, ${frames}f${end ? ", END PINNED" : ""}${has("no-tiled") ? " [untiled]" : " [tiled VAE]"}`);
    console.log("note: NO negative prompt on this leg — BasicGuider runs at cfg 1, so WAN_NEGATIVE does not apply");
    console.log(`prompt: ${prompt}`);

    // ── the memory trace ────────────────────────────────────────────────────
    const logPath = join(homedir(), "comfy", "comfy.log");
    let logFrom = 0;
    try { logFrom = statSync(logPath).size; } catch { /* no log is not fatal */ }
    const memAvailableGiB = () => {
      const m = /MemAvailable:\s+(\d+) kB/.exec(readFileSync("/proc/meminfo", "utf8"));
      return m ? Number(m[1]) / 1024 / 1024 : NaN;
    };
    const trace = [];
    let floor = memAvailableGiB();
    const sampler = setInterval(() => {
      const g = memAvailableGiB();
      trace.push({ t: Date.now(), availGiB: Number(g.toFixed(2)) });
      if (g < floor) floor = g;
    }, 2000);

    try {
      await run(graph, dir, {
        mode: "h3", label: `h3 · ${label}`.slice(0, 60), params,
        clip: mode.presets?.find((p) => p.id === preset)?.clip || undefined,
        resolvedPrompt: prompt, seed: Number(opt("seed", 7)),
      });
    } finally {
      clearInterval(sampler);
      let modelLines = [];
      try {
        modelLines = readFileSync(logPath, "utf8").slice(logFrom).split("\n")
          .filter((l) => /Requested to load|loaded completely|loaded partially|Unloading|unload_all_models|lowvram/i.test(l));
      } catch { /* ditto */ }
      writeFileSync(join(dir, "h3-memory.json"), JSON.stringify({
        minAvailGiB: Number(floor.toFixed(2)), samples: trace.length, trace, modelLines,
      }, null, 1));
      console.log(`\nPEAK RESIDENT → minimum MemAvailable ${floor.toFixed(2)} GiB over ${trace.length} samples`);
      console.log(floor < 3 ? "  ✗ below chapter 14's 3 GiB kill criterion" : "  ✓ above chapter 14's 3 GiB kill criterion");
      if (modelLines.length) console.log("comfy model management:\n  " + modelLines.join("\n  "));
      else console.log("comfy model management: NO load/unload lines — cannot confirm the encoder freed before the unet loaded");
    }
  },
};

if (!main[cmd]) {
  console.error("usage: cli.mjs <stats|create|rotate|edit|animate|h3|retarget|posemap|pose|refile> [--flags]  (see file header)");
  process.exit(2);
}
main[cmd]().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
