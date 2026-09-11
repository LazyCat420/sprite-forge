/**
 * POST /api/comfy/settings — persist panel settings to
 * ~/comfy/forge-settings.json (outside the repo: deploy.sh ships the
 * working tree and the Civitai token is a secret).
 *
 * Accepts any subset of {comfyUrl, civitaiToken, chosen}. An empty-string
 * civitaiToken CLEARS the stored token; omitting the field keeps it — so
 * the panel can save a URL change without knowing the token.
 */
import { NextResponse } from "next/server";
import {
  backendPresent,
  loadSettings,
  saveSettings,
} from "../../../../src/game/pinball-knight/tools/sprite-forge/comfy/forge-config.mjs";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!backendPresent()) return NextResponse.json({ error: "no backend on this machine" }, { status: 404 });
  const body = await req.json();
  const patch: Record<string, unknown> = {};
  if (typeof body.comfyUrl === "string" && body.comfyUrl.trim()) patch.comfyUrl = body.comfyUrl.trim();
  if (typeof body.civitaiToken === "string") patch.civitaiToken = body.civitaiToken.trim();
  if (body.chosen && typeof body.chosen === "object")
    patch.chosen = { ...loadSettings().chosen, ...body.chosen };
  const next = saveSettings(patch);
  return NextResponse.json({
    settings: { comfyUrl: next.comfyUrl, civitaiTokenSet: !!next.civitaiToken, chosen: next.chosen },
  });
}
