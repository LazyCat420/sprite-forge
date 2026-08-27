import { NextResponse } from "next/server";
import { selectTargetForFacing } from "@/engine/cluster/spark-client";
import {
  buildConceptGraph,
  buildTurnaroundGraph,
  buildMultiViewTurnaroundGraph,
  buildMultiRefMovesetGraph,
} from "@/engine/comfy/graphs";
import {
  fetchAllOutputImages,
  fetchOutputImage,
  queuePrompt,
  uploadBase64Image,
  waitForPrompt,
} from "@/engine/comfy/client";

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
      cameraOffset = 0,
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
    let northUploaded: string | undefined;

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
    if (northDataUrl) {
      northUploaded = await uploadBase64Image(
        northDataUrl,
        `north_${character}_${Date.now()}.png`,
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
        cameraOffset,
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
        backImage: northUploaded,
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

    if (mode === "multiview_turnaround") {
      const allOutputs = await fetchAllOutputImages(history, comfyUrl);
      if (allOutputs.length === 0) {
        return NextResponse.json({ ok: false, error: "No multi-view images generated" }, { status: 500 });
      }

      const frontImg = allOutputs.find((o) => o.filename.includes("front") || o.nodeId === "save_front");
      const eastImg = allOutputs.find((o) => o.filename.includes("east") || o.nodeId === "save_east");
      const northImg = allOutputs.find((o) => o.filename.includes("north") || o.nodeId === "save_north");
      const sheetImg = allOutputs.find((o) => o.filename.includes("sheet") || o.nodeId === "save_sheet");

      const frontUrl = frontImg?.dataUrl || allOutputs[0]?.dataUrl;
      const eastUrl = eastImg?.dataUrl || (allOutputs.length > 1 ? allOutputs[1]?.dataUrl : allOutputs[0]?.dataUrl);
      const northUrl = northImg?.dataUrl || (allOutputs.length > 2 ? allOutputs[2]?.dataUrl : allOutputs[0]?.dataUrl);
      const sheetUrl = sheetImg?.dataUrl || (allOutputs.length > 3 ? allOutputs[3]?.dataUrl : allOutputs[0]?.dataUrl);

      return NextResponse.json({
        ok: true,
        promptId,
        frontUrl,
        eastUrl,
        northUrl,
        sheetUrl,
        imageDataUrl: sheetUrl || frontUrl,
      });
    }

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
