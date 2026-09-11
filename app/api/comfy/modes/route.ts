/**
 * The panel's task menu — modes.mjs serialized with availability baked in.
 *
 * The panel never learns LoRA filenames or sampler params; it learns "this
 * mode exists, needs these inputs, offers these fields, and fast mode is
 * (un)available". Everything that changes what a generation DOES lives
 * server-side in the registry.
 */
import { NextResponse } from "next/server";
import { serializeModes } from "../../../../src/game/pinball-knight/tools/sprite-forge/comfy/modes.mjs";
import { optionById } from "../../../../src/game/pinball-knight/tools/sprite-forge/comfy/manifest.mjs";
import { backendPresent, installState } from "../../../../src/game/pinball-knight/tools/sprite-forge/comfy/forge-config.mjs";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!backendPresent()) return NextResponse.json({ error: "no backend on this machine" }, { status: 404 });
  const has = (optionId: string) => {
    const o = optionById(optionId);
    return o ? installState(o).state === "installed" : false;
  };
  return NextResponse.json({ modes: serializeModes(has) });
}
