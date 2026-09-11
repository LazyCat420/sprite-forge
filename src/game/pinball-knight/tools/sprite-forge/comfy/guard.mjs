#!/usr/bin/env node
/**
 * RAM GUARD — the failsafe that keeps generation from freezing the box.
 *
 * On 2026-08-05 ComfyUI (model swaps parked in system RAM) plus a test run
 * filled all 64GB and froze the HOST. WSL only sees its own ~47GiB slice,
 * so this guard watches BOTH sides:
 *
 *   WSL  /proc/meminfo MemAvailable, every 2s — fast, free, catches spikes.
 *   HOST PowerShell interop (Win32_OperatingSystem), every 5s — the real
 *        64GB number the freeze actually hit. Skipped quietly where
 *        interop is unavailable.
 *
 * Rules, in escalation order (rendering is always the sacrifice — a lost
 * frame re-queues, a frozen host loses everything):
 *
 *   SOFT   wsl avail < 1.2GiB (instant)  → interrupt + drop cached models
 *          host used > 61GB   (instant)  → same
 *   HARD   wsl avail < 0.5GiB (instant)  → stop the ComfyUI server
 *          wsl avail < 2.5GiB sustained 60s → stop
 *          host used > 62.5GB sustained ~15s (3 samples) → stop
 *
 * WSL floors are calibrated to the 40GB-CAPPED VM (post-.wslconfig) by
 * three measured retunes on 2026-08-05: a healthy Wan run's deepest
 * transient leaves ~4-6GiB available, and every floor above that has
 * interrupted a WORKING job. With the cap, the host tripwire is the real
 * freeze protection; the WSL floors only catch true runaway.
 *
 *   node guard.mjs [--soft 1.2] [--hard 0.5] [--sustain 2.5] [--sustain-secs 60]
 *                  [--host-soft-used 61] [--host-hard-used 62.5] [--once]
 *
 * State for the panel: heartbeat ~/comfy/guard.json each poll (with
 * hostUsedGB when known), trip record ~/comfy/guard-tripped.json (cleared
 * by the next server start). Zero dependencies; pid at ~/comfy/guard.pid.
 */
import { execFile, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const COMFY = process.env.COMFY_HOME ?? join(homedir(), "comfy");
const URL = process.env.COMFY_URL ?? "http://127.0.0.1:8188";
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
};
// LAYERS BY ROLE — the product of seven calibration runs on 2026-08-05,
// every WSL instant-floor strike of which was a false positive on healthy
// work (load dips to ~8, standalone decode to 2.8, two-leg decode to
// ~1.5 as cache from 36GB of touched model files lags eviction):
//   · host freeze is impossible by construction (.wslconfig 40GB cap) and
//     the HOST tripwire below is the operator's named backstop;
//   · true WSL runaway is the SUSTAINED rule's job (2.5GiB/60s — resting
//     with a cached stack is ~2.8 and temporary; the route frees models
//     5min after the queue drains);
//   · 16GB of swap absorbs ten-second transients;
//   · the instant floors are last-inch reflexes ONLY — below 1.2 nothing
//     healthy has ever been measured, and the alternative is the kernel
//     OOM-killing comfy (recoverable, but messier than our interrupt).
const SOFT_GIB = arg("soft", 1.2);
const HARD_GIB = arg("hard", 0.5);
const SUSTAIN_GIB = arg("sustain", 2.5);
const SUSTAIN_SECS = arg("sustain-secs", 60);
// ── RAISED 58 → 61 ON 2026-08-05, AGAINST A MEASUREMENT ────────────────────
//
// The previous note had the right rule and the wrong number. It reasoned "a
// fully loaded but HEALTHY box peaks ~57GB (40 cap + Windows baseline), so a
// softer floor would strike legitimate generation on every run" — and then set
// the floor at 58, one gigabyte above a baseline that has since grown.
//
// Measured, three consecutive keyframe runs: Windows non-WSL is **28.7GB**,
// not the ~17GB assumed. WSL idles at 21.6GB and grows ~12GB to load the Qwen
// stack, so a healthy generation peaks at **58.9GB** — above the old floor by
// 0.9GB. The guard therefore interrupted every single keyframe job mid-sample,
// three times out of three, and reported it as `[comfy] execution failed: []`.
//
// This is the SAME defect the WSL-side floors had (they went 3 → 2 → 1.2 GiB
// for it): a floor calibrated above the workload's real envelope does not
// protect the box, it just makes the box useless while looking like a bug in
// whatever it killed.
//
// 61 leaves 2.9GB of margin over the measured peak and 2.9GB under the physical
// ceiling. The real protection was never this instant strike anyway — it is
// HARD, which requires the pressure to be SUSTAINED across 3 samples (~15s).
// A transient spike during a model load is exactly what should not trip.
//
// ⚠️ If the Windows baseline grows again, RE-MEASURE rather than nudging:
//     powershell.exe -NoProfile -Command "(Get-Process vmmemWSL).WorkingSet64/1GB"
//   against Win32_OperatingSystem's used total. The gap is the baseline.
const HOST_SOFT_USED_GB = arg("host-soft-used", 61);
const HOST_HARD_USED_GB = arg("host-hard-used", 62.5);
const POLL_MS = arg("poll", 2000);
const HOST_POLL_MS = 5000;
const HOST_HARD_SAMPLES = 3; // 3 × 5s ≈ the "sustained" the freeze needs
const COOLDOWN_MS = 30_000;

function availGiB() {
  const m = /MemAvailable:\s+(\d+) kB/.exec(readFileSync("/proc/meminfo", "utf8"));
  return m ? Number(m[1]) / 2 ** 20 : NaN;
}

/** Host-side memory via WSL interop; resolves null where unavailable. */
function hostMem() {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-Command", "Get-CimInstance Win32_OperatingSystem | Select-Object -Property FreePhysicalMemory,TotalVisibleMemorySize | ConvertTo-Json"],
      { timeout: 4000 },
      (err, out) => {
        if (err) return resolve(null);
        try {
          const j = JSON.parse(String(out).replace(/\r/g, ""));
          resolve({ used: (j.TotalVisibleMemorySize - j.FreePhysicalMemory) / 2 ** 20, total: j.TotalVisibleMemorySize / 2 ** 20 });
        } catch {
          resolve(null);
        }
      },
    );
  });
}

const log = (s) => console.log(`[guard ${new Date().toISOString()}] ${s}`);

/**
 * ── RECLAIM THE PAGE CACHE BEFORE KILLING ANYBODY'S WORK ────────────────────
 *
 * MEASURED 2026-08-08, one attack clip, sampled every 3s:
 *
 *     host used     35.32 → 60.65 GB   (+25.3)
 *     comfy RSS      1.02 → 11.11 GB   (+10.1)
 *     wsl available 31.28 → 23.50 GB   (-7.8 ONLY)
 *
 * The host grew 25GB while ComfyUI grew 10 and Linux barely noticed. The
 * missing ~15GB is PAGE CACHE: a Wan run reads two GGUF experts of 11.2GB
 * each, 22.4GB per run, and Linux caches every byte. `MemAvailable` counts
 * that as available because it is reclaimable — so `free` looks healthy
 * throughout — while Windows sees vmmemWSL balloon by the full amount and
 * counts it as USED. This is not a leak and it is not ComfyUI: it happens on
 * every run by construction.
 *
 * Which means the host tripwire fires on memory that is FREE FOR THE ASKING.
 * Interrupting the job is the wrong first move; dropping the cache reclaims
 * ~15-20GB in about a second and the run continues.
 *
 * Needs root, and the guard deliberately does not assume it has any. Without
 * the sudoers line it logs once, says what to add, and falls through to the
 * old behaviour — a guard that silently stopped protecting the box because a
 * privilege was missing would be worse than one that never tried.
 *
 *   sudo tee /etc/sudoers.d/bdb-dropcaches <<'EOF'
 *   lazycat ALL=(root) NOPASSWD: /usr/bin/tee /proc/sys/vm/drop_caches
 *   EOF
 *   sudo chmod 0440 /etc/sudoers.d/bdb-dropcaches
 */
let cacheDropWarned = false;
function dropPageCache() {
  const before = availGiB();
  try {
    execFileSync("sudo", ["-n", "/usr/bin/tee", "/proc/sys/vm/drop_caches"], {
      input: "3\n",
      stdio: ["pipe", "ignore", "ignore"],
      timeout: 15_000,
    });
  } catch {
    if (!cacheDropWarned) {
      cacheDropWarned = true;
      log(
        "cannot drop the page cache (no passwordless sudo) — a Wan run's 22GB of model reads " +
          "will keep counting against the HOST. See the note above dropPageCache in guard.mjs.",
      );
    }
    return null;
  }
  const after = availGiB();
  return { before, after, freedGiB: after - before };
}

let lastSoft = 0;
async function softStrike(why) {
  if (Date.now() - lastSoft < COOLDOWN_MS) return;
  lastSoft = Date.now();

  // The cheap reclaim first. `freed` is measured, not assumed, so a drop that
  // recovers nothing still falls through to the interrupt rather than
  // congratulating itself — the pressure might be real this time.
  const dropped = dropPageCache();
  if (dropped && dropped.freedGiB > 1) {
    log(`SOFT (${why}) — dropped the page cache, reclaimed ${dropped.freedGiB.toFixed(1)}GiB; letting the job continue`);
    return;
  }

  log(`SOFT (${why}) — interrupting + dropping cached models`);
  try {
    await fetch(`${URL}/interrupt`, { method: "POST" });
    await fetch(`${URL}/free`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
    });
  } catch (e) {
    log(`comfy unreachable during soft strike (${e.message}) — nothing to free`);
  }
}

function hardStrike(why, detail) {
  log(`HARD (${why}) — stopping ComfyUI`);
  writeFileSync(
    join(COMFY, "guard-tripped.json"),
    JSON.stringify({ when: new Date().toISOString(), ...detail, action: `stopped ComfyUI (${why})` }, null, 1),
  );
  execFile("bash", [join(COMFY, "stop.sh")], (err, out) => log(`stop.sh: ${err ? err.message : String(out).trim()}`));
}

if (process.argv.includes("--once")) {
  const a = availGiB();
  const h = await hostMem();
  console.log(
    JSON.stringify({
      wslAvailGiB: +a.toFixed(2),
      host: h ? { usedGB: +h.used.toFixed(1), totalGB: +h.total.toFixed(1) } : "interop unavailable",
      verdict:
        a < HARD_GIB || (h && h.used > HOST_HARD_USED_GB) ? "HARD" : a < SOFT_GIB || (h && h.used > HOST_SOFT_USED_GB) ? "SOFT" : "ok",
    }),
  );
  process.exit(0);
}

const hostProbe = await hostMem();
log(
  `watching — wsl: soft ${SOFT_GIB} / hard ${HARD_GIB} / sustained <${SUSTAIN_GIB}GiB for ${SUSTAIN_SECS}s · ` +
    (hostProbe
      ? `host (${hostProbe.total.toFixed(0)}GB): soft >${HOST_SOFT_USED_GB}GB used / hard >${HOST_HARD_USED_GB}GB used sustained ${(HOST_HARD_SAMPLES * HOST_POLL_MS) / 1000}s`
      : "host: interop unavailable, WSL rules only"),
);
writeFileSync(join(COMFY, "guard.pid"), String(process.pid));

let sustainSince = null;
let host = hostProbe;
let hostHardStreak = 0;

const tick = () => {
  const avail = availGiB();
  try {
    writeFileSync(
      join(COMFY, "guard.json"),
      JSON.stringify({
        pid: process.pid,
        at: Date.now(),
        availGiB: +avail.toFixed(2),
        softGiB: SOFT_GIB,
        hardGiB: HARD_GIB,
        ...(host ? { hostUsedGB: +host.used.toFixed(1), hostTotalGB: +host.total.toFixed(1), hostHardUsedGB: HOST_HARD_USED_GB } : {}),
      }),
    );
  } catch {
    /* heartbeat is best-effort */
  }

  if (avail < HARD_GIB) {
    return hardStrike("wsl hard floor", { availGiB: +avail.toFixed(2) });
  }
  // The creep case: nothing spikes below the hard floor, but the box sits
  // squeezed — exactly how the freeze looked from inside for its last minute.
  if (avail < SUSTAIN_GIB) {
    sustainSince ??= Date.now();
    if (Date.now() - sustainSince > SUSTAIN_SECS * 1000) {
      return hardStrike("wsl sustained pressure", {
        availGiB: +avail.toFixed(2),
        sustainedS: Math.round((Date.now() - sustainSince) / 1000),
      });
    }
  } else {
    sustainSince = null;
  }
  if (avail < SOFT_GIB) void softStrike(`wsl ${avail.toFixed(1)}GiB available`);
};

const hostTick = async () => {
  const h = await hostMem();
  if (!h) return;
  host = h;
  if (h.used > HOST_HARD_USED_GB) {
    hostHardStreak++;
    if (hostHardStreak >= HOST_HARD_SAMPLES) {
      return hardStrike(`host sustained >${HOST_HARD_USED_GB}GB used`, { hostUsedGB: +h.used.toFixed(1) });
    }
  } else {
    hostHardStreak = 0;
  }
  if (h.used > HOST_SOFT_USED_GB) void softStrike(`host ${h.used.toFixed(1)}GB used`);
};

setInterval(tick, POLL_MS);
if (hostProbe) setInterval(hostTick, HOST_POLL_MS);
void tick();

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    try {
      rmSync(join(COMFY, "guard.json"), { force: true });
      rmSync(join(COMFY, "guard.pid"), { force: true });
    } catch {
      /* leave stale files rather than die noisily */
    }
    process.exit(0);
  });
}
