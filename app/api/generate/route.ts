import { NextResponse } from "next/server";
import { selectActiveComfyTarget } from "@/engine/cluster/spark-client";
import { buildConceptGraph, buildTurnaroundGraph, buildMovesetGraph } from "@/engine/comfy/graphs";
import { fetchOutputImage, queuePrompt, waitForPrompt } from "@/engine/comfy/client";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { mode = "concept", prompt, character = "knight", facing = "S", action = "walk", seed } = body;

    const comfyUrl = await selectActiveComfyTarget();

    let graph: Record<string, any>;
    if (mode === "turnaround") {
      graph = buildTurnaroundGraph({
        image: body.image,
        facing,
        character,
        seed,
      });
    } else if (mode === "moveset") {
      graph = buildMovesetGraph({
        character,
        action,
        facing,
        seed,
      });
    } else {
      graph = buildConceptGraph({
        prompt: prompt || `pixel art 32x48 sprite of a fantasy ${character}, centered full body, solid flat chroma green background`,
        seed,
      });
    }

    const promptId = await queuePrompt(graph, comfyUrl);
    const history = await waitForPrompt(promptId, comfyUrl, 45000, 1000);

    const outputs = Object.values(history.outputs ?? {}) as any[];
    const firstOutput = outputs[0];
    const imageInfo = firstOutput?.images?.[0];

    if (!imageInfo) {
      return NextResponse.json({ ok: false, error: "No output images generated" }, { status: 500 });
    }

    const imageBuf = await fetchOutputImage(imageInfo, comfyUrl);
    const base64 = imageBuf.toString("base64");
    const dataUrl = `data:image/png;base64,${base64}`;

    return NextResponse.json({
      ok: true,
      promptId,
      filename: imageInfo.filename,
      imageDataUrl: dataUrl,
    });
  } catch (err: any) {
    console.error("[generate API error]", err);
    return NextResponse.json(
      { ok: false, error: err?.message || String(err) },
      { status: 500 }
    );
  }
}
