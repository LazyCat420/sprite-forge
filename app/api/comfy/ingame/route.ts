/**
 * SEE IT IN THE GAME — the loop that closes the forge.
 *
 *   POST {kind, shots?, every?, aggro?, count?}  → screenshots of that
 *        creature alive in the real dungeon, on the real GPU
 *   GET  ?kinds=1                                → the spawnable roster
 *
 * A crushed contact sheet answers "do these frames look right". Only the
 * running game answers "does this READ at 84 texels against a dungeon
 * floor, does the loop pop, did the published art even reach the
 * renderer" — the last one comes back as `imported`, scraped from the
 * boot line `boot/sheets.ts` already prints.
 *
 * The work happens in scripts/sprite-shot.mjs (a Windows-side Chrome over
 * CDP, because WebGPU is unreachable from WSL2 and SwiftShader would
 * render a different image than ships). This route is transport: spawn it,
 * read its JSON, hand the PNGs back as data URLs.
 *
 * SLOW BY NATURE — a cold browser plus a fresh run plus pipeline compile is
 * ~40-60s. The panel calls it with a long timeout rather than polling,
 * because unlike a generation there is nothing partial to show.
 */
import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { KIND_IDS, KIND_INFO } from "../../../../src/game/pinball-knight/bestiary";
import { backendPresent } from "../../../../src/game/pinball-knight/tools/sprite-forge/comfy/forge-config.mjs";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request) {
  if (!backendPresent()) return NextResponse.json({ error: "no backend on this machine" }, { status: 404 });
  if (new URL(req.url).searchParams.get("kinds")) {
    return NextResponse.json({
      kinds: KIND_IDS.map((k) => ({ id: k, label: KIND_INFO[k].label, icon: KIND_INFO[k].icon })),
    });
  }
  return NextResponse.json({ error: "unknown query — GET ?kinds=1" }, { status: 400 });
}

export async function POST(req: Request) {
  if (!backendPresent()) return NextResponse.json({ error: "no backend on this machine" }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const kind = String(body.kind ?? "");
  // Only a real EnemyKind reaches the shell — this spawns a process.
  if (!(KIND_IDS as readonly string[]).includes(kind)) {
    return NextResponse.json({ error: `unknown monster "${kind}"` }, { status: 400 });
  }
  const args = [
    "scripts/sprite-shot.mjs",
    "--kind", kind,
    "--json",
    "--shots", String(Math.max(1, Math.min(12, Number(body.shots) || 5))),
    "--every", String(Math.max(120, Math.min(3000, Number(body.every) || 600))),
    "--count", String(Math.max(1, Math.min(6, Number(body.count) || 3))),
    ...(body.aggro ? ["--aggro"] : []),
  ];

  return new Promise<NextResponse>((resolve) => {
    const p = spawn("node", args, { cwd: process.cwd() });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", () => {
      // The script prints exactly one JSON line on --json; anything else on
      // stdout is a harness log and is not the answer.
      const line = out.split("\n").reverse().find((l) => l.trim().startsWith("{"));
      let parsed: { ok?: boolean; error?: string; shots?: string[]; imported?: string[]; placed?: unknown } = {};
      try {
        parsed = line ? JSON.parse(line) : {};
      } catch {
        /* fall through to the error below */
      }
      if (!parsed.ok) {
        return resolve(
          NextResponse.json(
            { error: parsed.error ?? `capture failed${err ? `: ${err.split("\n").slice(-3).join(" ")}` : ""}` },
            { status: 502 },
          ),
        );
      }
      const shots = (parsed.shots ?? []).flatMap((f) => {
        try {
          return ["data:image/png;base64," + readFileSync(f).toString("base64")];
        } catch {
          return [];
        }
      });
      resolve(
        NextResponse.json({
          ok: true,
          kind,
          shots,
          placed: parsed.placed ?? null,
          // Empty means a PAINTER drew this creature — the published art never
          // reached the renderer, which is the failure worth naming loudly.
          imported: parsed.imported ?? [],
        }),
      );
    });
  });
}
