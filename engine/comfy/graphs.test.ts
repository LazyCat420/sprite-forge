import { describe, expect, it } from "vitest";
import {
  buildConceptGraph,
  buildMultiViewTurnaroundGraph,
  buildMultiRefMovesetGraph,
  buildTurnaroundGraph,
} from "./graphs";

describe("DGX Spark ComfyUI Graph Builders suite", () => {
  it("builds Krea 2 Concept Graph with optional Krea2StyleReferenceHelper", () => {
    const graph = buildConceptGraph({
      prompt: "heroic paladin knight in silver armor",
      styleName: "darkbrush",
    });

    expect(graph["1"].class_type).toBe("UNETLoader");
    expect(graph["1"].inputs.unet_name).toContain("krea2");
    expect(graph["2"].class_type).toBe("CLIPLoader");
    expect(graph["8"].class_type).toBe("VAEDecode");
    expect(graph["9"].class_type).toBe("SaveImage");
    expect(graph["style_helper"].class_type).toBe("Krea2StyleReferenceHelper");
    expect(graph["style_helper"].inputs.style_name).toBe("darkbrush");
  });

  it("builds SV3D 360-degree Orbit MultiView Turnaround Graph", () => {
    const graph = buildMultiViewTurnaroundGraph({
      image: "master_ref.png",
      engine: "sv3d",
      character: "knight",
      cameraOffset: 5,
    });

    expect(graph["1"].class_type).toBe("LoadImage");
    expect(graph["1"].inputs.image).toBe("master_ref.png");
    expect(graph["3"].inputs.ckpt_name).toBe("sv3d_u.safetensors");
    expect(graph["9"].inputs.batch_size).toBe(21);

    // Assert MultiView custom nodes
    expect(graph["selector"].class_type).toBe("MultiViewBatchSelector");
    expect(graph["selector"].inputs.azimuth_offset).toBe(5);
    expect(graph["sheet_builder"].class_type).toBe("MultiViewSheetBuilder");
    expect(graph["sheet_builder"].inputs.layout).toBe("horizontal_strip");

    // Assert isolated canonical save outputs
    expect(graph["save_front"].inputs.filename_prefix).toBe("spriteforge/multiview_front");
    expect(graph["save_east"].inputs.filename_prefix).toBe("spriteforge/multiview_east");
    expect(graph["save_north"].inputs.filename_prefix).toBe("spriteforge/multiview_north");
    expect(graph["save_sheet"].inputs.filename_prefix).toBe("spriteforge/multiview_sheet");
  });

  it("builds Zero123++ 6-View MultiView Turnaround Graph", () => {
    const graph = buildMultiViewTurnaroundGraph({
      image: "master_ref.png",
      engine: "zero123",
      character: "rogue",
    });

    expect(graph["1"].class_type).toBe("LoadImage");
    expect(graph["3"].inputs.unet_name).toBe("zero123plus_fp16.safetensors");
    expect(graph["9"].inputs.batch_size).toBe(6);

    expect(graph["selector"].class_type).toBe("MultiViewBatchSelector");
    expect(graph["sheet_builder"].class_type).toBe("MultiViewSheetBuilder");
    expect(graph["save_front"]).toBeDefined();
    expect(graph["save_east"]).toBeDefined();
    expect(graph["save_north"]).toBeDefined();
    expect(graph["save_sheet"]).toBeDefined();
  });

  it("builds MiniMax H3 Multi-Reference Moveset Graph with <Picture 1..3> packing", () => {
    const graph = buildMultiRefMovesetGraph({
      character: "knight",
      action: "attack_slash",
      facing: "E",
      frontImage: "knight_front.png",
      sideImage: "knight_east.png",
      backImage: "knight_north.png",
    });

    expect(graph["1"].class_type).toBe("UNETLoader");
    expect(graph["1"].inputs.unet_name).toContain("minimax_h3");
    expect(graph["prompt_formatter"].class_type).toBe("MiniMaxH3PromptFormatter");
    expect(graph["prompt_formatter"].inputs.character).toBe("knight");
    expect(graph["prompt_formatter"].inputs.action).toBe("attack_slash");
    expect(graph["prompt_formatter"].inputs.num_references).toBe(3);

    // Multi-reference inputs
    expect(graph["load_front"].inputs.image).toBe("knight_front.png");
    expect(graph["load_side"].inputs.image).toBe("knight_east.png");
    expect(graph["load_back"].inputs.image).toBe("knight_north.png");
    expect(graph["ref_packer"].class_type).toBe("MiniMaxH3MultiRefPacker");
    expect(graph["ref_packer"].inputs.image_1).toEqual(["load_front", 0]);
    expect(graph["ref_packer"].inputs.image_2).toEqual(["load_side", 0]);
    expect(graph["ref_packer"].inputs.image_3).toEqual(["load_back", 0]);

    expect(graph["9"].inputs.filename_prefix).toBe("spriteforge/moveset_attack_slash_E");
  });

  it("builds Single-Facing Turnaround Graph", () => {
    const graphEast = buildTurnaroundGraph({
      character: "knight",
      facing: "E",
      image: "front_ref.png",
    });
    expect(graphEast["1"].inputs.image).toBe("front_ref.png");
    expect(graphEast["12"].inputs.filename_prefix).toBe("spriteforge/minimax_turnaround_E");

    const graphNorth = buildTurnaroundGraph({
      character: "knight",
      facing: "N",
    });
    expect(graphNorth["9"].inputs.filename_prefix).toBe("spriteforge/minimax_turnaround_N");
  });
});
