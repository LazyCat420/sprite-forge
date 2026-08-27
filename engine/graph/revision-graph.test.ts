import { describe, expect, it } from "vitest";
import {
  addRevision,
  createClipGraph,
  getAcceptedFrames,
  isClipPublishable,
  promoteRevision,
  setSlotStatus,
} from "./revision-graph";

describe("sprite-forge revision-graph suite", () => {
  it("initializes a clip graph with stable slots in pending state", () => {
    const graph = createClipGraph("knight", "walk", "S", 8);
    expect(graph.id).toBe("knight-walk-S");
    expect(graph.slots.length).toBe(8);
    expect(graph.slots[0].status).toBe("pending");
    expect(isClipPublishable(graph)).toBe(false);
  });

  it("appends revisions to a slot and flags issues", () => {
    const graph = createClipGraph("knight", "walk", "S", 4);

    const rev0 = addRevision(graph, 0, {
      sourceType: "initial_generation",
      imagePath: "/work/knight/frame-0.png",
      analysis: { issues: ["head-shift"] },
    });

    expect(graph.slots[0].revisions.length).toBe(1);
    expect(graph.slots[0].status).toBe("flagged");

    const rev1 = addRevision(graph, 0, {
      id: "rev-1-head-fixed",
      parentId: rev0.id,
      sourceType: "inpaint_patch",
      imagePath: "/work/knight/frame-0-fixed.png",
      analysis: { issues: [] },
    });

    expect(graph.slots[0].revisions.length).toBe(2);

    promoteRevision(graph, 0, rev1.id);
    expect(graph.slots[0].acceptedRevisionId).toBe(rev1.id);
    expect(graph.slots[0].status).toBe("accepted");
  });

  it("checks publishability: true only when all slots are accepted", () => {
    const graph = createClipGraph("knight", "idle", "E", 2);

    addRevision(graph, 0, {
      sourceType: "initial_generation",
      imagePath: "/work/idle-0.png",
      analysis: { issues: [] },
    });
    expect(isClipPublishable(graph)).toBe(false);

    addRevision(graph, 1, {
      sourceType: "initial_generation",
      imagePath: "/work/idle-1.png",
      analysis: { issues: [] },
    });
    expect(isClipPublishable(graph)).toBe(true);

    setSlotStatus(graph, 1, "rejected");
    expect(isClipPublishable(graph)).toBe(false);
  });

  it("retrieves accepted frames in sequential order", () => {
    const graph = createClipGraph("knight", "attack", "N", 2);
    addRevision(graph, 0, {
      id: "rev-att-0",
      sourceType: "initial_generation",
      imagePath: "/work/att-0.png",
      analysis: { issues: [] },
    });
    addRevision(graph, 1, {
      id: "rev-att-1",
      sourceType: "initial_generation",
      imagePath: "/work/att-1.png",
      analysis: { issues: [] },
    });

    const accepted = getAcceptedFrames(graph);
    expect(accepted.length).toBe(2);
    expect(accepted[0].revision?.id).toBe("rev-att-0");
    expect(accepted[1].revision?.id).toBe("rev-att-1");
  });
});
