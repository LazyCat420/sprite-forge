/**
 * Clip Revision Graph Engine.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { FrameMetrics, Rect } from "../cv/anchor-debugger";

export type Facing = "S" | "N" | "E";

export type FrameIssue =
  | "head-shift"
  | "extra-limb"
  | "double-image"
  | "scale-drift"
  | "ground-slip"
  | "palette-bleach"
  | "lattice-mush"
  | "artifact";

export type SlotStatus = "pending" | "accepted" | "flagged" | "repairing" | "rejected";

export type RevisionSourceType =
  | "initial_generation"
  | "wan_i2v"
  | "qwen_edit"
  | "inpaint_patch"
  | "bridge_inbetween"
  | "manual_paint";

export interface FrameAnalysis extends Partial<FrameMetrics> {
  purityScore?: number;
  ghostScore?: number;
  sweepDrift?: number;
  groundSpreadPx?: number;
  temporalDeltaPrev?: number;
  temporalDeltaNext?: number;
  issues: FrameIssue[];
}

export interface FrameRevision {
  id: string;
  parentId?: string;
  sourceType: RevisionSourceType;
  imagePath: string;
  previewPath?: string;
  generationRecipe?: {
    prompt?: string;
    seed?: number;
    model?: string;
    maskRect?: Rect;
    protectedValid?: boolean;
    temporalReferences?: { prev?: string; next?: string };
  };
  analysis: FrameAnalysis;
  authoredAt: string;
}

export interface FrameSlot {
  slot: number;
  acceptedRevisionId: string | null;
  status: SlotStatus;
  issues: FrameIssue[];
  revisions: FrameRevision[];
}

export interface SpriteClipGraph {
  id: string;
  character: string;
  action: string;
  facing: Facing;
  canonicalCanvas: { width: number; height: number };
  canonicalAnchor: { x: number; y: number };
  slots: FrameSlot[];
  updatedAt: string;
}

export function createClipGraph(
  character: string,
  action: string,
  facing: Facing,
  frameCount: number,
  canvas = { width: 32, height: 48 },
  anchor = { x: 16, y: 44 }
): SpriteClipGraph {
  const id = `${character}-${action}-${facing}`;
  const slots: FrameSlot[] = [];

  for (let i = 0; i < frameCount; i++) {
    slots.push({
      slot: i,
      acceptedRevisionId: null,
      status: "pending",
      issues: [],
      revisions: [],
    });
  }

  return {
    id,
    character,
    action,
    facing,
    canonicalCanvas: canvas,
    canonicalAnchor: anchor,
    slots,
    updatedAt: new Date().toISOString(),
  };
}

export function addRevision(
  graph: SpriteClipGraph,
  slotIndex: number,
  revisionData: Omit<FrameRevision, "id" | "authoredAt"> & { id?: string }
): FrameRevision {
  if (slotIndex < 0 || slotIndex >= graph.slots.length) {
    throw new Error(`Slot index ${slotIndex} out of range`);
  }

  const slot = graph.slots[slotIndex];
  const revisionId = revisionData.id ?? `rev-${slot.revisions.length}-${Date.now().toString(36)}`;
  const revision: FrameRevision = {
    ...revisionData,
    id: revisionId,
    authoredAt: new Date().toISOString(),
  };

  slot.revisions.push(revision);

  if (!slot.acceptedRevisionId && slot.status === "pending") {
    if (revision.analysis.issues.length === 0) {
      slot.acceptedRevisionId = revision.id;
      slot.status = "accepted";
    } else {
      slot.status = "flagged";
      slot.issues = [...revision.analysis.issues];
    }
  }

  graph.updatedAt = new Date().toISOString();
  return revision;
}

export function promoteRevision(graph: SpriteClipGraph, slotIndex: number, revisionId: string): void {
  if (slotIndex < 0 || slotIndex >= graph.slots.length) {
    throw new Error(`Slot index ${slotIndex} out of bounds`);
  }

  const slot = graph.slots[slotIndex];
  const rev = slot.revisions.find((r) => r.id === revisionId);
  if (!rev) {
    throw new Error(`Revision ${revisionId} not found in slot ${slotIndex}`);
  }

  slot.acceptedRevisionId = revisionId;
  slot.status = "accepted";
  slot.issues = [...rev.analysis.issues];
  graph.updatedAt = new Date().toISOString();
}

export function setSlotStatus(graph: SpriteClipGraph, slotIndex: number, status: SlotStatus): void {
  if (slotIndex < 0 || slotIndex >= graph.slots.length) {
    throw new Error(`Slot index ${slotIndex} out of bounds`);
  }

  const slot = graph.slots[slotIndex];
  slot.status = status;
  if (status === "rejected") {
    slot.acceptedRevisionId = null;
  }
  graph.updatedAt = new Date().toISOString();
}

export function isClipPublishable(graph: SpriteClipGraph): boolean {
  if (graph.slots.length === 0) return false;
  return graph.slots.every((slot) => slot.status === "accepted" && slot.acceptedRevisionId !== null);
}

export function getAcceptedFrames(graph: SpriteClipGraph): Array<{ slot: number; revision: FrameRevision | null }> {
  return graph.slots.map((slot) => {
    const rev = slot.revisions.find((r) => r.id === slot.acceptedRevisionId) ?? null;
    return {
      slot: slot.slot,
      revision: rev,
    };
  });
}

export function saveClipGraph(filePath: string, graph: SpriteClipGraph): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(graph, null, 2) + "\n", "utf8");
}

export function loadClipGraph(filePath: string): SpriteClipGraph | null {
  try {
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, "utf8")) as SpriteClipGraph;
  } catch {
    return null;
  }
}
