#!/usr/bin/env node
/**
 * THE WHOLE MATRIX, UNATTENDED — every clip × every facing for one creature.
 *
 *   node bench-moveset.mjs --character dog --master ../sources/dog-2026-08-07/09_wan_00696_.png
 *   node bench-moveset.mjs --character dog --master <png> --facings E --clips idle,run
 *   node bench-moveset.mjs --character dog --master <png> --resume
 *
 * 7 clips × 3 facings = 21 runs at 6–15 min each, so a full sweep is 3–5 hours
 * of GPU. It prints a matrix at the end and writes `bench-<character>.json`.
 *
 * ── IT SHELLS OUT TO cli.mjs, DELIBERATELY ──────────────────────────────────
 *
 * Every run goes through `cli.mjs animate` as a subprocess rather than calling
 * the graph builders directly. This repo has been bitten three separate times
 * by a second caller that drifted from the first — `animate` never reached
 * MODES and so lost its `avoid` clauses, `retarget` passed a stub ctx that
 * silently disabled every LoRA, and `rotate` restated its prompt and never
 * loaded the multi-angle LoRA at all. A benchmark that re-implemented the
 * generation path would be measuring a pipeline nobody ships.
 *
 * The cost is process startup per run, which against a 600-second generation is
 * nothing.
 *
 * ── THE --loop POLICY IS THE POINT OF THIS FILE ─────────────────────────────
 *
 * Measured 2026-08-08: `--loop` pins frame 1 == frame 21, and on a clip with no
 * strong intrinsic motion "never move" satisfies both endpoints perfectly.
 * `idle4 --loop` produced 2 distinct bounding boxes across 21 frames; the same
 * command without it produced 12. `run4 --loop` produced ONE.
 *
 * So the pin is applied per clip, from `LOOPING`, and never globally. Getting
 * this wrong costs the whole sweep — twenty corpses that all pass the ghost
 * gate. See `documentation/chapters/12-the-clip-that-does-not-move.md`.
 *
 * ── QUADRUPED PRESETS ───────────────────────────────────────────────────────
 *
 * `--body quadruped` (the default here) maps each clip to its `*4` preset. The
 * unnumbered presets are written in biped vocabulary — `attack` hands the
 * creature a WEAPON, `run` asks for a "two-step run cycle", `defend` describes
 * a shield block. Pass `--body biped` for a humanoid.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d;
};
const has = (n) => args.includes(`--${n}`);

/**
 * The clip contract, in play order. `crouch` is the leaper telegraph and has NO
 * painter fallback; `idle` is the one `importedPaints` refuses a sheet without.
 */
const CLIPS = ["idle", "walk", "run", "attack", "stumble", "crouch", "death"];

/** Clips whose motion genuinely returns to its start pose. ONLY these get the pin. */
const LOOPING = new Set(["walk", "run"]);

/** clip -> preset id, per body plan. */
const PRESET = {
  quadruped: { idle: "idle4", walk: "walk4", run: "run4", attack: "attack4", stumble: "stumble4", crouch: "defend4", death: "death4" },
  biped: { idle: "idle", walk: "walk", run: "run", attack: "attack", stumble: "stumble", crouch: "defend", death: "death" },
};

const character = opt("character", "dog");
const master = opt("master");
const body = opt("body", "quadruped");
const facings = opt("facings", "E,S,N").split(",").map((s) => s.trim()).filter(Boolean);
const clips = opt("clips", CLIPS.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
const frames = opt("frames", "21");
const seed = opt("seed", "7");
const resultsPath = join(HERE, `bench-${character}.json`);

if (!master) throw new Error("bench-moveset needs --master <png> (the ONE approved master; facings are rotated from it)");
if (!PRESET[body]) throw new Error(`--body must be quadruped|biped, got "${body}"`);

/** Prior results, so a killed sweep can pick up where it stopped. */
const results = has("resume") && existsSync(resultsPath) ? JSON.parse(readFileSync(resultsPath, "utf8")) : {};
const save = () => writeFileSync(resultsPath, JSON.stringify(results, null, 1) + "\n");

/**
 * ── THE SWEEP PUBLISHES ITSELF, BECAUSE A JOB BANNER IS NOT ENOUGH ──────────
 *
 * Reported by the operator, after the per-job banner was already shipped and
 * verified working: "from my end I have no clue it's running, I have to look at
 * task manager."
 *
 * Both halves of that are fair, and the job banner cannot fix either:
 *
 *   1. BETWEEN ROWS THERE IS NO JOB. Every row calls /free and reloads ~31GB of
 *      weights, so for 30-90 seconds nothing is queued and the panel correctly
 *      reports "0 running". Across 21 rows that is twenty dead-looking gaps in
 *      a sweep that is working perfectly.
 *   2. NOTHING KNEW A SWEEP EXISTED. The panel sees individual jobs; the bench
 *      is a separate process it has never heard of. The operator's question is
 *      not "is a job running", it is "is the pipeline working", and no page
 *      could answer it.
 *
 * So the sweep writes its own state beside the runs, on every transition. The
 * file is the transport, exactly as it is for a single run's heartbeat — no
 * socket, no registry, and it survives a dev-server reload because it was never
 * in memory. `_` prefix so the panel's run scan skips it.
 *
 * `finishedAt` is set on the way out, INCLUDING on a crash, so the panel can
 * distinguish "finished" from "died" — a sweep that stops updating with no
 * finishedAt is the shape of a killed process, and that is worth showing
 * differently from success.
 */
const sweepPath = join(HERE, "..", "work", "comfy", "_sweep.json");
const sweepStart = Date.now();
let sweepDone = 0;
const publishSweep = (patch = {}) => {
  try {
    const totalRows = facings.length * clips.length;
    const elapsed = Date.now() - sweepStart;
    writeFileSync(sweepPath, JSON.stringify({
      character, tool: "bench-moveset",
      startedAt: sweepStart, updatedAt: Date.now(),
      total: totalRows, done: sweepDone,
      /**
       * COMPLETE **WITHIN THIS INVOCATION'S SCOPE**, which is not the same as
       * "rows in the results file".
       *
       * Rows already on disk from an earlier `--resume` are not re-run, so
       * `done` (this process) and `completed` (on disk) genuinely differ and
       * both are worth showing — conflating them makes a resumed sweep look
       * stalled at 0.
       *
       * But the first version counted EVERY ok row in the file against a total
       * of only the facings this invocation was asked for. Resuming with
       * `--facings N,E` after the S facing had finished published
       * `completed: 8, total: 14` — 57% before a single requested row had run,
       * heading for 22/14 at the end. Caught by reading the JSON the banner
       * would render; the fraction has to be measured against the same set the
       * denominator is.
       */
      completed: facings.flatMap((f) => clips.map((c) => `${f}:${c}`)).filter((k) => results[k]?.ok).length,
      facings, clips,
      // Mean of THIS process's completed rows; null until one lands, because a
      // hardcoded guess is worse than an honest "unknown".
      etaS: sweepDone > 0 ? Math.round(((elapsed / sweepDone) * (totalRows - sweepDone)) / 1000) : null,
      ...patch,
    }, null, 1) + "\n");
  } catch { /* status must never take the sweep down */ }
};
// A crash or a kill still marks the end, so "stopped updating" and "finished"
// are distinguishable in the panel.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { publishSweep({ current: null, finishedAt: Date.now(), stopped: true }); process.exit(130); });
}

const sh = (args_) => execFileSync("node", args_, { cwd: HERE, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 24 });

/**
 * Drop the resident models between runs.
 *
 * Not a superstition: the A14B pair is ~31GB of reads and the guard interrupts
 * at 1.2GiB WSL-available. Runs in this session took 343s and 913s for the SAME
 * work, and the slow ones followed a run that had left weights resident. This
 * costs a reload and buys a predictable sweep.
 */
async function freeModels() {
  try {
    await fetch("http://127.0.0.1:8188/free", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
    });
    await new Promise((r) => setTimeout(r, 4000));
  } catch { /* a benchmark must not die because a housekeeping call failed */ }
}

/**
 * WHERE THE RUN ACTUALLY LANDED — read from the CLI, not guessed.
 *
 * `cli.mjs` ends every successful run with a line naming its output dir:
 *
 *     21 frame(s) in 451.0s -> /abs/path/animate-walk4-2026-08-08T22-19-38  (filed under dog)
 *
 * That is the authority. Parsing it is deterministic and cannot be confused by
 * anything else on disk.
 */
function runDirFromOutput(out) {
  const m = /->\s+(\S+)/.exec(out ?? "");
  return m && existsSync(m[1]) ? m[1] : null;
}

/**
 * Fallback only, and it sorts by MTIME rather than by name.
 *
 * ── WHY THIS BUG COST A WHOLE MATRIX ────────────────────────────────────────
 *
 * This used to `dirs.sort()` and take the last, which silently assumes every
 * directory name ends in a timestamp of identical format. `cli.mjs --out`
 * breaks that assumption, and two runs from the loop bisect were named
 * `animate-idle4-LIVE-2026-08-08`. "L" (0x4C) sorts after "2" (0x32), so that
 * directory won EVERY lookup for the `animate-idle4-` prefix — including for
 * runs generated hours later.
 *
 * The failure was silent and total: the bench recorded a real `tookS` next to
 * a dir that was not the run, so `job.motion` came back undefined and every
 * gate column in the matrix was `null`. A three-hour sweep would have produced
 * a report of dashes, with nothing anywhere saying it had looked in the wrong
 * place. Caught at 2 rows of 21.
 *
 * mtime is what "newest" actually means; the name is a label, not a clock.
 */
function newestRun(prefix) {
  const root = join(HERE, "..", "work", "comfy");
  const dirs = readdirSync(root)
    .filter((d) => d.startsWith(prefix))
    .map((d) => join(root, d))
    .filter((p) => statSync(p).isDirectory());
  if (!dirs.length) return null;
  return dirs.sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs).pop();
}

/** ── 1. the masters ───────────────────────────────────────────────────────
 *
 * ROTATE THROUGH THE PERPENDICULAR: E -> S (90°), then S -> N (90°).
 *
 * The obvious design — branch every facing off the ONE approved master so no
 * facing inherits another's drift — is what this file did first, and it is
 * wrong for N specifically. **E -> N in one step does not return a back view.
 * It returns the E master flipped horizontally**, measured at 0.942 silhouette
 * IoU against mirrored E, where the same test on a genuine turn scores ~0.52.
 *
 * From a side view, "back view" has two readings: turn the animal 180°, or
 * reflect it. Both put the head where the tail was, and the reflection is a
 * symmetry of the latent — free — while the true turn means synthesising the
 * entire unseen far side. The model takes the cheap reading. A FRONT view is
 * not reachable by any reflection of a side view, so E -> S and S -> N are
 * both unambiguous.
 *
 * The drift argument is still true and is simply outranked: two generations of
 * mild identity drift is a cost, a mirror is not a back view at all. See
 * `documentation/chapters/13-turning-a-character-and-the-colours-it-loses.md`.
 *
 * Diagonals do NOT need this: all four quarter views are within 90° of E or S.
 */
const ROTATE_FROM = { S: "E", N: "S", SE: "E", NE: "E", SW: "S", NW: "S" };
const masters = { E: master };
// S before N, so N has its source. Any facing whose source is not being built
// this run falls back to the E master and is flagged in the note.
const facingOrder = facings.filter((x) => x !== "E").sort((a, b) => (ROTATE_FROM[a] === "E" ? -1 : 1) - (ROTATE_FROM[b] === "E" ? -1 : 1));
for (const f of facingOrder) {
  if (results[`master:${f}`]?.ok && existsSync(results[`master:${f}`].file)) {
    masters[f] = results[`master:${f}`].file;
    console.log(`master ${f}: reusing ${masters[f]}`);
    continue;
  }
  // The source facing, per ROTATE_FROM. Falling back to E when the intended
  // source was not built is stated out loud rather than done quietly, because
  // for N that fallback is precisely the run that returns a mirror.
  const fromId = ROTATE_FROM[f] ?? "E";
  const from = masters[fromId] ?? master;
  const viaFallback = !masters[fromId] && fromId !== "E";
  console.log(`\n=== master ${f} — rotate from ${viaFallback ? `E (WANTED ${fromId}; expect a MIRROR for N)` : fromId} ===`);
  publishSweep({ current: `master:${f}`, currentPreset: "rotate", phase: "generating" });
  await freeModels();
  try {
    const out = sh(["cli.mjs", "rotate", "--init", from, "--to", f, "--file-as", character, "--seed", seed]);
    process.stdout.write(out);
    const dir = runDirFromOutput(out) ?? newestRun(`rotate-${f}-`);
    const pngs = dir ? readdirSync(dir).filter((n) => n.endsWith(".png")).sort() : [];
    if (!pngs.length) throw new Error("rotate produced no PNG");
    masters[f] = join(dir, pngs[0]);
    results[`master:${f}`] = { ok: true, file: masters[f], from: fromId, viaFallback, loraBanner: /fal-multi-angle LoRA/.test(out) };
  } catch (err) {
    console.error(`master ${f} FAILED: ${err.message}`);
    results[`master:${f}`] = { ok: false, error: String(err.message).slice(0, 400) };
  }
  save();
}

/** ── 2. the matrix ──────────────────────────────────────────────────────── */
for (const facing of facings) {
  if (!masters[facing]) {
    console.error(`\n### skipping facing ${facing} — no master`);
    continue;
  }
  for (const clip of clips) {
    const key = `${facing}:${clip}`;
    if (results[key]?.ok) { console.log(`${key}: already done, skipping`); continue; }
    const preset = PRESET[body][clip];
    const loop = LOOPING.has(clip);
    console.log(`\n=== ${key} — preset ${preset}${loop ? " --loop" : " (no loop: not a cycle)"} ===`);
    publishSweep({ current: key, currentPreset: preset, phase: "freeing models" });
    await freeModels();
    publishSweep({ current: key, currentPreset: preset, phase: "generating" });
    const t0 = Date.now();
    try {
      const argv = ["cli.mjs", "animate", "--init", masters[facing], "--preset", preset,
        "--frames", frames, "--seed", seed, "--file-as", character];
      if (loop) argv.push("--loop");
      const out = sh(argv);
      process.stdout.write(out);
      const dir = runDirFromOutput(out) ?? newestRun(`animate-${preset}-`);
      const job = dir && existsSync(join(dir, "job.json")) ? JSON.parse(readFileSync(join(dir, "job.json"), "utf8")) : null;
      // All THREE gates, because they fail on three different axes and a matrix
      // that reports one of them is a matrix that looks clean while a clip is
      // broken. motion = did it move; ghost = did a limb dissolve toward the
      // FIELD; fade = did a marking dissolve into the BODY. The last one was
      // wired into cli.mjs and omitted here, which would have left the operator's
      // reported defect — the hound's tan paws blinking out — absent from the
      // only summary anyone reads.
      const m = job?.motion, g = job?.ghost, f = job?.fade;
      const churn = m?.churn?.length ? [...m.churn].sort((a, b) => a - b)[m.churn.length >> 1] : null;
      results[key] = {
        ok: true, dir, preset, loop, tookS: Math.round((Date.now() - t0) / 1000),
        motion: m?.level ?? null, churnMedian: churn, boxes: m?.boxes ?? null, seam: m?.seam ?? null,
        scaleSwing: m?.scaleSwing ?? null, scaleTrend: m?.scaleTrend ?? null,
        ghost: g?.level ?? null, ghostWorst: g?.pct?.length ? Math.max(...g.pct) : null,
        fade: f?.level ?? null, fadeFlagged: f?.flagged ?? null, palette: f?.palette ?? null,
        fadeWorst: f?.worst ? Number((f.worst.drop * 100).toFixed(1)) : null, fadeWorstAt: f?.worst ?? null,
        frozen: m?.level === "reject",
      };
    } catch (err) {
      console.error(`${key} FAILED: ${err.message}`);
      results[key] = { ok: false, preset, loop, error: String(err.message).slice(0, 400), tookS: Math.round((Date.now() - t0) / 1000) };
    }
    sweepDone++;
    publishSweep({ current: null, phase: "between rows" });
    save();
  }
}

publishSweep({ current: null, phase: "done", finishedAt: Date.now() });

/** ── 3. the matrix report ────────────────────────────────────────────────── */
/**
 * One cell carries the churn AND a flag column, because a clip can be healthy
 * on one axis and broken on another — a frozen clip has perfect ghost scores,
 * and the fade defect was found on a clip that passed everything.
 *
 *   `!`  motion is only "usable"     `g` ghost flagged frames
 *   `f`  fade flagged frames         `~` fade soft-flagged (a marking dimmed)
 */
const cell = (r) => {
  if (!r) return "     —      ";
  if (!r.ok) return "   ERROR    ";
  if (r.frozen) return "  FROZEN    ";
  const flags =
    (r.motion === "usable" ? "!" : "") +
    (r.ghost && r.ghost !== "ready" ? "g" : "") +
    (r.fade === "reject" ? "F" : r.fade === "usable" ? "~" : "");
  return `${String(r.churnMedian ?? "?").padStart(6)}% ${flags.padEnd(4)}`;
};
console.log(`\n\n=== ${character} — churn median by clip x facing ===\n`);
console.log("clip       " + facings.map((f) => f.padEnd(12)).join(""));
for (const clip of clips) {
  console.log(clip.padEnd(11) + facings.map((f) => cell(results[`${f}:${clip}`])).join(""));
}
console.log("\n  ! motion only usable   g ghost flagged   ~ a marking dimmed   F a colour lost");
const all = clips.flatMap((c) => facings.map((f) => results[`${f}:${c}`])).filter(Boolean);
const frozen = all.filter((r) => r.frozen).length;
const errored = all.filter((r) => !r.ok).length;
const faded = all.filter((r) => r.fade && r.fade !== "ready").length;
const mins = Math.round(all.reduce((s, r) => s + (r.tookS ?? 0), 0) / 60);
console.log(`\n${all.length} runs · ${frozen} FROZEN · ${errored} errored · ${faded} with a colour flag · ${mins} min of GPU`);
console.log(`results -> ${resultsPath}`);
// The one line that has been right every time it was ignored.
console.log("\nA churn number is NOT approval. Render each survivor at 8fps and look at it.");
