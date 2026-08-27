import { NextResponse } from "next/server";
import { selectTargetForFacing } from "@/engine/cluster/spark-client";
import {
  buildConceptGraph,
  buildTurnaroundGraph,
  buildMultiViewTurnaroundGraph,
  buildMultiRefMovesetGraph,
} from "@/engine/comfy/graphs";
import { fetchOutputImage, queuePrompt, uploadBase64Image, waitForPrompt } from "@/engine/comfy/client";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const {
      mode = "concept",
      prompt,
      character = "knight",
      facing = "S",
      action = "walk",
      engine = "sv3d",
      initImageDataUrl,
      frontDataUrl,
      eastDataUrl,
      northDataUrl,
      denoise = 0.65,
      seed,
    } = body;

    const comfyUrl = await selectTargetForFacing(facing);

    let uploadedImageName: string | undefined;
    if (initImageDataUrl) {
      uploadedImageName = await uploadBase64Image(
        initImageDataUrl,
        `init_${character}_${facing}_${Date.now()}.png`,
        comfyUrl
      );
    }

    let frontUploaded: string | undefined;
    let eastUploaded: string | undefined;
    if (frontDataUrl) {
      frontUploaded = await uploadBase64Image(
        frontDataUrl,
        `front_${character}_${Date.now()}.png`,
        comfyUrl
      );
    }
    if (eastDataUrl) {
      eastUploaded = await uploadBase64Image(
        eastDataUrl,
        `east_${character}_${Date.now()}.png`,
        comfyUrl
      );
    }

    let graph: Record<string, any>;
    if (mode === "multiview_turnaround") {
      graph = buildMultiViewTurnaroundGraph({
        image: uploadedImageName || "concept_00001_.png",
        engine,
        character,
        seed,
      });
    } else if (mode === "turnaround") {
      graph = buildTurnaroundGraph({
        image: uploadedImageName,
        facing,
        character,
        seed,
        denoise,
      });
    } else if (mode === "moveset") {
      graph = buildMultiRefMovesetGraph({
        character,
        action,
        facing,
        frontImage: frontUploaded,
        sideImage: eastUploaded,
        seed,
      });
    } else {
      graph = buildConceptGraph({
        prompt: prompt || `pixel art 32x48 sprite of a fantasy ${character}, centered full body, solid flat chroma green background`,
        seed,
      });
    }

    const promptId = await queuePrompt(graph, comfyUrl);
    const history = await waitForPrompt(promptId, comfyUrl, 120000, 1000);

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
