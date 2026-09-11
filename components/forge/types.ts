/**
 * The panel's client-side view of the server contracts. Server truth lives
 * in modes.mjs (task registry), generate/route.ts (jobs) and
 * pipeline/route.ts (cut/crush/stage) — these types mirror, never define.
 */
import type { ClipName } from "@/src/game/pinball-knight/engine/render/paint-types";

export type Manifest = {
  backendPresent: boolean;
  comfyHome: string;
  comfy: { reachable: boolean; version?: string; device?: string; vramFreeGiB?: number; vramTotalGiB?: number };
  ram?: { availGiB: number | null; totalGiB: number | null };
  guard?: {
    running: boolean;
    availGiB?: number;
    softGiB?: number;
    hardGiB?: number;
    tripped?: { when: string; availGiB: number; action: string } | null;
  };
  settings: { comfyUrl: string; civitaiTokenSet: boolean; chosen: Record<string, string> };
  legs: any[];
};

export type ModeField = {
  id: string;
  label: string;
  type: "select" | "text";
  options?: { id: string; label: string }[];
  default?: string;
  placeholder?: string;
  required?: boolean;
  /** Only render when another field holds a value, e.g. {facing: "custom"}. */
  showIf?: Record<string, string>;
  /** Text field whose empty value is previewed from a preset select. */
  prefillFrom?: string;
};

export type Mode = {
  id: string;
  title: string;
  blurb: string;
  leg: "qwen" | "wan";
  needs: { init?: boolean; end?: boolean; mask?: boolean; style?: boolean | "optional" };
  fields: ModeField[];
  batch: { id: string; label: string; values: Record<string, string>[] } | null;
  presets: { id: string; label: string; action: string; clip: string }[] | null;
  etaS: { quality: number; fast: number };
  fastAvailable: boolean;
  notes: string[];
};

export type Progress = { node: string | null; value: number; max: number };

export type Job = {
  state: "queued" | "running" | "done" | "error" | "cancelled";
  leg?: string;
  mode: string;
  label: string;
  startedAt: number;
  params?: Record<string, string>;
  resolvedPrompt?: string;
  /**
   * The NEGATIVE actually sent. Half the prompt and, on the Wan leg, the half
   * doing the most work — the camera terms, the scale terms, the background
   * terms and the preset's `avoid` all live here. Absent on jobs generated
   * before it was recorded.
   */
  resolvedNegative?: string;
  seed?: number;
  fast?: boolean;
  project?: string;
  character?: string;
  clip?: string;
  progress?: Progress;
  /**
   * Last time a CLI run touched its job.json. Absent on panel-started jobs,
   * which live in the route's Map instead. It is what lets the route tell a
   * healthy 10-minute command-line generation (frameless, running, beating)
   * from a corpse left by a dev-server reload (frameless, running, silent) —
   * before this existed the first was reported as the second.
   */
  heartbeatAt?: number;
  hasPreview?: boolean;
  frames?: string[];
  error?: string;
  tookS?: number;
  note?: string;
  /**
   * Per-frame dissolved-limb score, written once when the frames land — see
   * `sprite-forge/ghost.ts`. ABSENT means "not measured", which is not the
   * same as "clean": the scorer needs a native PNG decoder and is allowed to
   * fail soft, so the panel must not draw a green badge from its silence.
   */
  ghost?: { pct: number[]; flagged: number[]; soft: number[]; level: string };
};

export type LibraryAsset = { label: string; url: string };

export type LibraryCharacter = {
  name: string;
  label: string;
  icon: string;
  blurb: string;
  kind: "player" | "monster" | "art-only";
  thumb: string | null;
  published: LibraryAsset[];
  inbox: LibraryAsset[];
  /** One entry per folder: the drop root (`group: null`) and each sub-folder. */
  sources: { drop: string; group: string | null; clip: string | null; files: LibraryAsset[] }[];
  recent: { jobId: string; label: string; startedAt: number; frames: LibraryAsset[] }[];
};

export type LibraryState = {
  projects: { id: string; title: string }[];
  activeProject: string | null;
  characters: LibraryCharacter[];
};

/**
 * A frame the user pulled aside for the sheet, tagged with its clip — and,
 * when the source knew it, its FACING.
 *
 * A sheet is one facing (`brute-S`), but the library shows `clip_S_walk` and
 * `clip_E_walk` as two adjacent folders with the same clip name. Adding both
 * would merge two facings into one `walk` row, and the result is a creature
 * that spins on the spot as it walks — visible only after publishing. The tag
 * is what lets the tray say so before the sheet is assembled.
 */
export type TrayFrame = {
  key: string;
  src: string;
  clip: string;
  facing?: string;
};

/**
 * Row order the game's sheets use; `stumble` is the stagger clip, not `hurt`.
 *
 * ⚠️ TYPED AGAINST `ClipName`, and that is not decoration.
 *
 * This shipped as a bare `as const` string list and immediately did what an
 * untyped hand-mirror does: it was MISSING `ball`, which `KNOWN_CLIPS`
 * (labels.ts) and `PLAYABLE` (imported-paints.ts) both carry. A `ball` clip
 * therefore could not be selected in the panel or reach the tray, and nothing
 * anywhere said so — the exact shape of the `hurt`/`stumble` bug that
 * `labels.ts` was rewritten to make impossible, one stage earlier.
 *
 * It stays a separate literal rather than `[...KNOWN_CLIPS]` because the ORDER
 * is a real affordance: it is the order rows are laid out in the sheet tray,
 * and a Set has none. `clip-names.test.ts` asserts the three lists hold the
 * same members, the way `camera-sync.test.ts` already does for the two copies
 * of `CAMERA_BY_DIR`.
 */
export const CLIP_NAMES = [
  "idle", "walk", "run", "attack", "stumble", "death", "roll", "ball", "crouch", "wait", "wake",
] as const satisfies readonly ClipName[];

export type CutResult = {
  ok: boolean;
  rows: { clip: string; cells: [number, number, number, number][] }[];
  labels: string[];
  slicedRows: number;
  matte: { pockets: number } | null;
  warnings: string[];
  suggestedSidecar: { rows: string[] };
  error?: string;
};

export type CrushResult = { ok: boolean; previewB64: string; report: string; frames: number; error?: string };

/**
 * A `bench-moveset.mjs` sweep in progress — the whole matrix, not one job.
 *
 * A sweep is 21 generations over several hours that frees the models between
 * each row, so for 30-90 seconds per row the jobs list is honestly EMPTY. The
 * per-job banner cannot represent that, and the operator's read of the gap was
 * "I have no clue it's running, I have to look at task manager". The bench
 * publishes this to `work/comfy/_sweep.json` on every transition.
 */
export type SweepState = {
  character: string;
  tool: string;
  startedAt: number;
  updatedAt: number;
  /** Rows this invocation intends to run. */
  total: number;
  /** Rows THIS process has finished — resumed rows are not counted here. */
  done: number;
  /** Rows complete on disk, including ones a previous run did. */
  completed: number;
  facings: string[];
  clips: string[];
  /** e.g. "N:walk", or "master:S", or null between rows. */
  current?: string | null;
  currentPreset?: string;
  /** "generating" | "freeing models" | "between rows" | "done". */
  phase?: string;
  /** Null until one row lands — a guessed ETA is worse than an honest unknown. */
  etaS?: number | null;
  finishedAt?: number;
  stopped?: boolean;
};
