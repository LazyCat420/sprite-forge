import { describe, expect, it } from "vitest";
import { minimaxH3I2V } from "./graphs.mjs";

describe("minimaxH3I2V ComfyUI graph builder", () => {
  it("builds a valid graph with VAEDecodeTiled by default", () => {
    const graph = minimaxH3I2V({
      image: "init.png",
      prompt: "a walking hound",
      width: 576,
      height: 576,
      length: 5,
      tileSize: 512,
      overlap: 32,
      temporalOverlap: 8,
    });

    expect(graph).toBeDefined();
    expect(graph.u.class_type).toBe("UnetLoaderGGUF");
    expect(graph.c.class_type).toBe("CLIPLoader");
    expect(graph.v.class_type).toBe("VAELoader");
    expect(graph.i2v.class_type).toBe("MiniMaxH3ImageToVideo");
    expect(graph.purgeTE.class_type).toBe("VRAM_Debug");
    expect(graph.purge.class_type).toBe("VRAM_Debug");

    // Check VAEDecodeTiled node wiring
    expect(graph.dec.class_type).toBe("VAEDecodeTiled");
    expect(graph.dec.inputs.tile_size).toBe(512);
    expect(graph.dec.inputs.overlap).toBe(32);
    expect(graph.dec.inputs.temporal_size).toBe(9); // length + 4 (5 + 4)
    expect(graph.dec.inputs.temporal_overlap).toBe(8);
  });

  it("builds untiled VAEDecode when tiled: false is set", () => {
    const graph = minimaxH3I2V({
      image: "init.png",
      prompt: "a walking hound",
      width: 576,
      height: 576,
      length: 5,
      tiled: false,
    });

    expect(graph.dec.class_type).toBe("VAEDecode");
  });

  it("supports pure text-to-video when image is omitted", () => {
    const graph = minimaxH3I2V({
      prompt: "a walking hound",
      width: 576,
      height: 576,
      length: 5,
    });

    expect(graph.img).toBeUndefined();
    expect(graph.i2v.inputs.first_frame).toBeUndefined();
  });

  it("adds endImage last_frame input when endImage is supplied", () => {
    const graph = minimaxH3I2V({
      image: "init.png",
      endImage: "end.png",
      prompt: "a walking hound",
      width: 576,
      height: 576,
      length: 5,
    });

    expect(graph.imgEnd).toBeDefined();
    expect(graph.imgEnd.inputs.image).toBe("end.png");
    expect(graph.i2v.inputs.last_frame).toEqual(["imgEnd", 0]);
  });

  it("throws validation errors for bad parameters", () => {
    expect(() => minimaxH3I2V({ prompt: "" })).toThrow(/needs a prompt/);
    expect(() => minimaxH3I2V({ prompt: "test", length: 10 })).toThrow(/17k\+5 grid/);
    expect(() => minimaxH3I2V({ prompt: "test", length: 5, width: 500 })).toThrow(/multiple of 32/);
  });
});
