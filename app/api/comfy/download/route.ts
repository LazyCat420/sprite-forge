/**
 * Model downloads, server-side.
 *
 *   POST {optionId}  start (or resume) downloading that manifest entry
 *   GET              state of every entry that has a live or failed job
 *
 * Progress is derived from the .part FILE SIZE, not from module memory —
 * Next dev reloads modules on edit, and a Map would forget a 12GB download
 * that is in fact still streaming. The in-memory map only carries error
 * text. Downloads resume with a Range header when a .part exists, so a
 * dead dev server costs nothing but the re-POST.
 *
 * Civitai entries get the stored API token appended (their API 401s
 * anonymous downloads); the token never leaves this process.
 */
import { NextResponse } from "next/server";
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { optionById } from "../../../../src/game/pinball-knight/tools/sprite-forge/comfy/manifest.mjs";
import {
  backendPresent,
  loadSettings,
  modelsDir,
} from "../../../../src/game/pinball-knight/tools/sprite-forge/comfy/forge-config.mjs";

export const dynamic = "force-dynamic";

/** optionId → {state: "downloading"|"error"|"done", error?} — advisory only. */
const jobs: Map<string, { state: string; error?: string }> = (globalThis as any).__forgeDl ?? new Map();
(globalThis as any).__forgeDl = jobs;

async function download(opt: any, token: string) {
  const dest = join(modelsDir(), opt.file);
  const part = dest + ".part";
  mkdirSync(dirname(dest), { recursive: true });
  const have = existsSync(part) ? statSync(part).size : 0;
  let url = opt.url;
  const headers: Record<string, string> = {};
  if (opt.kind === "civitai") {
    if (!token) throw new Error("This model downloads from Civitai, which needs your API key — add it in Settings.");
    url += (url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token);
  }
  if (have > 0) headers.Range = `bytes=${have}-`;
  const r = await fetch(url, { headers, redirect: "follow" });
  if (r.status === 401 || r.status === 403)
    throw new Error(opt.kind === "civitai" ? "Civitai rejected the API key (401) — re-check it in Settings." : `auth rejected (${r.status})`);
  if (!r.ok && r.status !== 206) throw new Error(`download failed: HTTP ${r.status}`);
  if (!r.body) throw new Error("empty response body");
  const resumed = r.status === 206;
  await pipeline(Readable.fromWeb(r.body as any), createWriteStream(part, { flags: resumed ? "a" : "w" }));
  renameSync(part, dest);
}

export async function POST(req: Request) {
  if (!backendPresent()) return NextResponse.json({ error: "no backend on this machine" }, { status: 404 });
  const { optionId } = await req.json();
  const opt = optionById(optionId);
  if (!opt) return NextResponse.json({ error: `unknown model id ${optionId}` }, { status: 400 });
  if (jobs.get(optionId)?.state === "downloading")
    return NextResponse.json({ ok: true, note: "already downloading" });
  jobs.set(optionId, { state: "downloading" });
  const token = loadSettings().civitaiToken;
  download(opt, token)
    .then(() => jobs.set(optionId, { state: "done" }))
    .catch((e) => jobs.set(optionId, { state: "error", error: e.message ?? String(e) }));
  return NextResponse.json({ ok: true });
}

export async function GET() {
  return NextResponse.json({ jobs: Object.fromEntries(jobs) });
}
