import { describe, expect, it } from "vitest";
import {
  buildConceptGraph,
  buildMultiViewTurnaroundGraph,
  buildMultiRefMovesetGraph,
  buildTurnaroundGraph,
} from "./graphs";

describe("DGX Spark ComfyUI Graph Builders suite (UNETLoader Models)", () => {
  it("builds Krea 2 Concept Graph", () => {
    const graph = buildConceptGraph({
      prompt: "heroic paladin knight in silver armor",
    });

    expect(graph["1"].class_type).toBe("UNETLoader");
    expect(graph["1"].inputs.unet_name).toContain("krea2");
    expect(graph["2"].class_type).toBe("CLIPLoader");
    expect(graph["8"].class_type).toBe("VAEDecode");
    expect(graph["9"].class_type).toBe("SaveImage");
  });

  it("builds 360-degree Turnaround Graph with UNETLoader and native ImageFromBatch slices", () => {
    const graph = buildMultiViewTurnaroundGraph({
      image: "master_ref.png",
      engine: "sv3d",
      character: "knight",
      cameraOffset: 2,
    });

    expect(graph["1"].class_type).toBe("LoadImage");
    expect(graph["1"].inputs.image).toBe("master_ref.png");
    expect(graph["3"].class_type).toBe("UNETLoader");
    expect(graph["3"].inputs.unet_name).toBe("minimax_h3_ref2va_pruned_int8_convrot.safetensors");
    expect(graph["9"].class_type).toBe("ReferenceLatent");
    expect(graph["10"].inputs.batch_size).toBe(21);

    // Assert ImageFromBatch slice nodes
    expect(graph["slice_front"].class_type).toBe("ImageFromBatch");
    expect(graph["slice_front"].inputs.batch_index).toBe(0);
    expect(graph["slice_east"].class_type).toBe("ImageFromBatch");
    expect(graph["slice_east"].inputs.batch_index).toBe(7); // 5 + 2
    expect(graph["slice_north"].class_type).toBe("ImageFromBatch");
    expect(graph["slice_north"].inputs.batch_index).toBe(12); // 10 + 2

    // Assert isolated canonical save outputs
    expect(graph["save_front"].inputs.filename_prefix).toBe("spriteforge/multiview_front");
    expect(graph["save_east"].inputs.filename_prefix).toBe("spriteforge/multiview_east");
    expect(graph["save_north"].inputs.filename_prefix).toBe("spriteforge/multiview_north");
    expect(graph["save_sheet"].inputs.filename_prefix).toBe("spriteforge/multiview_sheet");
  });

  it("builds 6-View MultiView Turnaround Graph with native ImageFromBatch slices", () => {
    const graph = buildMultiViewTurnaroundGraph({
      image: "master_ref.png",
      engine: "zero123",
      character: "rogue",
    });

    expect(graph["1"].class_type).toBe("LoadImage");
    expect(graph["3"].class_type).toBe("UNETLoader");
    expect(graph["10"].inputs.batch_size).toBe(6);

    expect(graph["slice_front"].class_type).toBe("ImageFromBatch");
    expect(graph["slice_front"].inputs.batch_index).toBe(0);
    expect(graph["slice_east"].class_type).toBe("ImageFromBatch");
    expect(graph["slice_east"].inputs.batch_index).toBe(1);
    expect(graph["slice_north"].class_type).toBe("ImageFromBatch");
    expect(graph["slice_north"].inputs.batch_index).toBe(3);

    expect(graph["save_front"]).toBeDefined();
    expect(graph["save_east"]).toBeDefined();
    expect(graph["save_north"]).toBeDefined();
    expect(graph["save_sheet"]).toBeDefined();
  });

  it("builds MiniMax H3 Multi-Reference Moveset Graph with <Picture 1..3>", () => {
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
    expect(graph["4"].inputs.text).toContain("<Picture 1> <Picture 2> <Picture 3>");

    // Multi-reference inputs
    expect(graph["load_front"].inputs.image).toBe("knight_front.png");
    expect(graph["load_side"].inputs.image).toBe("knight_east.png");
    expect(graph["load_back"].inputs.image).toBe("knight_north.png");

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
