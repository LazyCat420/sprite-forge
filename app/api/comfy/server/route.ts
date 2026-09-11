/**
 * POST /api/comfy/server {action: "start"|"stop"} — run the backend's own
 * launcher scripts. Present only where the backend is (backendPresent()
 * gates it), which is what keeps this exec surface off the deployed NAS
 * container: no ~/comfy there, so the route is a 404.
 *
 * After a start we poll /system_stats for up to 20s so the panel gets a
 * definitive up/still-booting answer instead of a race.
 */
import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import { openSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  backendPresent,
  comfyHome,
  loadSettings,
} from "../../../../src/game/pinball-knight/tools/sprite-forge/comfy/forge-config.mjs";

export const dynamic = "force-dynamic";

const GUARD = () => join(process.cwd(), "src/game/pinball-knight/tools/sprite-forge/comfy/guard.mjs");

/**
 * The RAM guard lives and dies with the server: no ComfyUI, nothing worth
 * watching; ComfyUI up without the guard is how the box froze on 08-05.
 * Its strikes go to ~/comfy/guard.log — a soft strike leaves no trip
 * marker, and "Processing interrupted" in comfy.log with nothing saying
 * WHY cost a debugging round tonight.
 */
function startGuard() {
  let out: number | "ignore" = "ignore";
  try {
    out = openSync(join(comfyHome(), "guard.log"), "a");
  } catch {
    /* unwritable comfy home — run silent rather than not at all */
  }
  // Spawned through bash, not `spawn("node", [path])`: Turbopack statically
  // traces node-script spawns and tries to BUNDLE the target ("server
  // relative imports are not implemented yet"), which failed every `next
  // build` of main. bash's argv is opaque to the analyzer, and runScript()
  // below already spawns bash, so this adds no new runtime dependency.
  const p = spawn("bash", ["-c", 'exec node "$1"', "bash", GUARD()], {
    detached: true,
    stdio: ["ignore", out, out],
  });
  p.unref();
}

function stopGuard() {
  try {
    const pid = Number(readFileSync(join(comfyHome(), "guard.pid"), "utf8"));
    if (pid > 1) process.kill(pid, "SIGTERM");
  } catch {
    /* not running */
  }
}

function runScript(script: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const p = spawn("bash", [join(comfyHome(), script), ...(script === "run.sh" ? ["-d"] : [])], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code, out: out.trim() }));
  });
}

export async function POST(req: Request) {
  if (!backendPresent()) return NextResponse.json({ error: "no backend on this machine" }, { status: 404 });
  const { action } = await req.json();
  if (action === "free") {
    const url = loadSettings().comfyUrl;
    try {
      await fetch(`${url}/free`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unload_models: true, free_memory: true }),
      });
      return NextResponse.json({ ok: true, freed: true });
    } catch (e: any) {
      return NextResponse.json({ error: e.message }, { status: 500 });
    }
  }
  if (action !== "start" && action !== "stop")
    return NextResponse.json({ error: "action must be start, stop or free" }, { status: 400 });

  const { code, out } = await runScript(action === "start" ? "run.sh" : "stop.sh");
  if (code !== 0) return NextResponse.json({ error: `script exited ${code}: ${out}` }, { status: 500 });

  if (action === "stop") stopGuard();
  if (action === "start") {
    // Fresh run, fresh verdicts: a stale trip marker would scare the panel.
    rmSync(join(comfyHome(), "guard-tripped.json"), { force: true });
    stopGuard();
    startGuard();
    const url = loadSettings().comfyUrl;
    for (let i = 0; i < 20; i++) {
      try {
        const r = await fetch(`${url}/system_stats`, { signal: AbortSignal.timeout(1000), cache: "no-store" });
        if (r.ok) return NextResponse.json({ ok: true, up: true });
      } catch {
        /* still booting */
      }
      await new Promise((res) => setTimeout(res, 1000));
    }
    return NextResponse.json({ ok: true, up: false, note: "started but not answering yet — check ~/comfy/comfy.log" });
  }
  return NextResponse.json({ ok: true, out });
}
