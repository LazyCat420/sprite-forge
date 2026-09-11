/**
 * GET /api/comfy/manifest — everything the /forge panel needs in one poll:
 * the model registry with per-file install state, the settings (token
 * REDACTED to a boolean — it must never round-trip to the browser), and a
 * liveness probe of the ComfyUI server itself.
 *
 * Runs on the Next server, which is the same WSL box as ~/comfy — that is
 * the whole trick: the browser never talks to ComfyUI or HuggingFace
 * directly, so there is no CORS story and no token in the page.
 */
import { NextResponse } from "next/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LEGS } from "../../../../src/game/pinball-knight/tools/sprite-forge/comfy/manifest.mjs";
import {
  backendPresent,
  comfyHome,
  installState,
  loadSettings,
} from "../../../../src/game/pinball-knight/tools/sprite-forge/comfy/forge-config.mjs";

export const dynamic = "force-dynamic";

/** System RAM + the guard's heartbeat/trip record — the freeze telemetry. */
function ramAndGuard() {
  let availGiB: number | null = null;
  let totalGiB: number | null = null;
  try {
    const mi = readFileSync("/proc/meminfo", "utf8");
    availGiB = +(Number(/MemAvailable:\s+(\d+) kB/.exec(mi)?.[1] ?? 0) / 2 ** 20).toFixed(1);
    totalGiB = +(Number(/MemTotal:\s+(\d+) kB/.exec(mi)?.[1] ?? 0) / 2 ** 20).toFixed(1);
  } catch {
    /* not linux — panel just hides the RAM line */
  }
  let guard: { running: boolean; availGiB?: number; softGiB?: number; hardGiB?: number } = { running: false };
  try {
    const hb = JSON.parse(readFileSync(join(comfyHome(), "guard.json"), "utf8"));
    // A heartbeat older than 15s is a dead guard, not a running one.
    guard = { running: Date.now() - hb.at < 15_000, availGiB: hb.availGiB, softGiB: hb.softGiB, hardGiB: hb.hardGiB };
  } catch {
    /* no heartbeat */
  }
  let tripped: { when: string; availGiB: number; action: string } | null = null;
  try {
    tripped = JSON.parse(readFileSync(join(comfyHome(), "guard-tripped.json"), "utf8"));
  } catch {
    /* clean */
  }
  return { ram: { availGiB, totalGiB }, guard: { ...guard, tripped } };
}

async function probeComfy(url: string) {
  try {
    const r = await fetch(`${url}/system_stats`, { signal: AbortSignal.timeout(1500), cache: "no-store" });
    if (!r.ok) return { reachable: false as const };
    const s = await r.json();
    const d = s.devices?.[0] ?? {};
    return {
      reachable: true as const,
      version: s.system?.comfyui_version ?? "?",
      device: d.name ?? "?",
      vramFreeGiB: d.vram_free ? +(d.vram_free / 2 ** 30).toFixed(1) : null,
      vramTotalGiB: d.vram_total ? +(d.vram_total / 2 ** 30).toFixed(1) : null,
    };
  } catch {
    return { reachable: false as const };
  }
}

export async function GET() {
  const present = backendPresent();
  const settings = loadSettings();
  const legs = present
    ? LEGS.map((leg: any) => ({
        ...leg,
        slots: leg.slots.map((slot: any) => ({
          ...slot,
          options: slot.options.map((o: any) => ({ ...o, install: installState(o) })),
        })),
      }))
    : LEGS;
  return NextResponse.json({
    backendPresent: present,
    comfyHome: comfyHome(),
    comfy: present ? await probeComfy(settings.comfyUrl) : { reachable: false },
    ...(present ? ramAndGuard() : {}),
    settings: { comfyUrl: settings.comfyUrl, civitaiTokenSet: !!settings.civitaiToken, chosen: settings.chosen },
    legs,
  });
}
