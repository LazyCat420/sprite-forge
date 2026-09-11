/**
 * THE BUILD PLAN — what a character owes the game, decided before any GPU runs.
 *
 * The forge could already make every part of a character. What it could not do
 * was OWN one. You picked a move, launched, waited, found the job card, cut it
 * into cells, dragged rows into the tray, then did that seventeen more times
 * for the other moves and facings. The art was never the bottleneck; the
 * book-keeping was.
 *
 * A `CharacterBuild` is that book-keeping made durable. It names one approved
 * master frame, one camera, a set of facings and a set of clips, and from there
 * it can say — at any moment, after any crash or dev-server reload — exactly
 * which of its 72 cells exist, which passed, and which still owe work.
 *
 * ── THE ONE RULE THAT MATTERS ───────────────────────────────────────────────
 * Every generated cell branches off the MASTER, never off a previous output.
 * Qwen-Image-Edit's identity drift compounds over serial edits: an edit of an
 * edit of an edit is a different creature, and it gets there smoothly enough
 * that no single step looks wrong. `KEYFRAME_SET` in `comfy/modes.mjs` already
 * obeys this. The planner must never be the thing that breaks it.
 *
 * Pure: no node imports. Enforced by testkit/testkit-boundary.test.ts.
 */

import type { ClipName, Dir } from "../../engine/render/paint-types";
import { KNOWN_CLIPS } from "./labels";
import type { QaVerdict } from "./intake-qa";

/**
 * ── CAMERA IS PER-FACING, NOT PER-MOVE ──────────────────────────────────────
 *
 * `KEYFRAME_MOVES[].camera` used to pin walk/run to a true side view and
 * attack/stumble/death to three-quarter, because each move reads best that
 * way in isolation. In isolation is the problem: the game does not play one
 * clip, it cuts between them. A creature that walks in profile and attacks in
 * three-quarter visibly TELEPORTS the moment combat starts, and the sheet that
 * produced it looked perfect in every contact sheet.
 *
 * So the camera belongs to the facing. Every clip of an E build is a side view;
 * every clip of an S build faces the camera. It costs the attack some depth and
 * buys two things: the creature never pops, and — because every cell in a
 * facing is now shot from one viewpoint — `drift.ts` can compare them to each
 * other at all. A drift metric across mixed cameras measures the camera.
 *
 * This closes the ⬜ open question in docs/ANY_IMAGE_TO_CHARACTER.md, Stage 2.
 */
export const CAMERA_BY_DIR: Readonly<Record<Dir, string>> = {
  E: "true side view, facing right, camera at eye level",
  S: "front view, facing the camera, camera at eye level",
  N: "back view, facing away from the camera, camera at eye level",
};

/**
 * The facings a build may author, in the order it should build them.
 *
 * **W is never here.** The engine draws west by flipping east
 * (`imported-paints.ts`), so authoring it means paying for art the game
 * discards and inviting a left/right mismatch when the two disagree.
 *
 * E leads because it is the facing the intake master is framed in, so it is the
 * only one that needs no rotation — if E fails, the character is wrong and the
 * other two are wasted GPU.
 */
export const BUILD_DIRS: readonly Dir[] = ["E", "S", "N"] as const;

export interface ClipSpec {
  /**
   * The game clip these cells land under. Typed as `ClipName`, so the obvious
   * wrong answer — `hurt`, which every reference sheet prints above that row —
   * is a compile error rather than a row the importer drops in silence.
   */
  clip: ClipName;
  /** `KEYFRAME_MOVES[].id` — the pose script that generates it. */
  move: string;
  /** How many extreme poses. The pose table is the authority; 4 today. */
  keys: number;
  /**
   * A build refuses to publish without this clip. Only `idle` is truly
   * required — `importedPaints` drops a whole sheet that lacks one, silently,
   * and the stiltneck shipped for weeks and never drew because of it.
   */
  required: boolean;
  /**
   * Which key should land on the engine's fixed attack windup, 0-based.
   *
   * NOT an event frame — the engine has no such concept, and hit windows are
   * wall-clock seconds in `constants/player.ts`. This only feeds
   * `ActorPaints.beats`, which retimes the CLIP so its visual impact coincides
   * with a window that was already going to happen regardless.
   */
  strikeKey?: number;
}

export type BuildState =
  | "draft"            // exists, no approved master yet
  | "master-approved"  // intake said ready/usable and a human accepted it
  | "planned"          // clips and facings chosen; nothing generated
  | "generating"       // jobs are queued or running
  | "review"           // every job finished; cells await culling
  | "assembled"        // rows chosen, sheet cut and crushed
  | "published"        // public/sprites/ written
  | "verified";        // the game printed the import line

/** One (clip, facing) row's worth of state. */
export interface RowState {
  clip: ClipName;
  dir: Dir;
  /** Generation job, once launched. */
  jobId?: string;
  /** Approved cell images, in key order. Paths under the build's work dir. */
  cells: string[];
  /** Per-cell drift verdicts, index-aligned with `cells`. */
  verdicts: QaVerdict[];
  /** Clip-level verdict — duplicate keys and the like. */
  clipVerdict?: QaVerdict;
  state: "pending" | "queued" | "running" | "review" | "approved" | "failed";
  /** Why it failed, in words a human can act on. */
  error?: string;
}

export interface CharacterBuild {
  id: string;
  /** The published sheet basename. Must satisfy `NAME_RE`. */
  name: string;
  kind: "player" | "monster";
  archetype: "melee" | "ranged" | "caster" | "boss";
  /** The approved intake frame every job branches from, per facing. */
  masters: Partial<Record<Dir, { jobId: string; frame: string; qa: QaVerdict }>>;
  facings: Dir[];
  clips: ClipSpec[];
  state: BuildState;
  /** Key: `${clip}:${dir}`. */
  rows: Record<string, RowState>;
  createdAt: number;
}

/** The same shape `opStage` validates, so a build can never name an unstageable sheet. */
export const NAME_RE = /^[a-z0-9_]+$/;

/**
 * The default clip set — SEVEN moves, and the seventh is why this comment was
 * rewritten on 2026-08-08.
 *
 * It mirrors `MOVESET` / `KEYFRAME_SET` in `comfy/modes.mjs`, and the previous
 * version of this comment said so in these words:
 *
 *   > Mirrors MOVESET/KEYFRAME_SET … the same SIX moves, the same clip mapping
 *   > (stagger is `stumble`, a block is `crouch`), because two lists of what a
 *   > character needs is how they drift apart.
 *
 * **They had already drifted, and the comment is what made it invisible.**
 * `MOVESET` carried seven entries (its `defend` preset files under the game
 * clip `crouch`); this list and `KEYFRAME_SET` carried six and dropped it. So
 * the comment named `crouch` as part of the mapping while the list beneath it
 * did not contain it, and every reader who checked the prose instead of the
 * array — including three sessions of this pipeline — read that as agreement.
 *
 * `crouch` is not cosmetic. `render/tell-clips.ts` resolves the leaper
 * telegraph to it, it is the hound's entire identity, and unlike `wake` it has
 * NO painter fallback — an unauthored `crouch` plays `idle` through
 * CLIP_FALLBACK and the player's one warning becomes a breathing monster. That
 * shipped, undetected, until `97eb184` fixed it by hand for one creature.
 *
 * ⚠️ `clip-contract.test.ts` now pins all three lists together, the same way
 * `camera-sync.test.ts` pins `CAMERA_BY_DIR`. Adding a move here without adding
 * it there fails the suite instead of silently splitting the contract. **Do not
 * "fix" a failure by editing the assertion.**
 *
 * `idle` is first and required for the reason the modes table already spells
 * out: a sheet without it is dropped whole, without an error.
 */
export const DEFAULT_CLIPS: readonly ClipSpec[] = [
  { clip: "idle", move: "idle", keys: 4, required: true },
  { clip: "walk", move: "walk", keys: 4, required: false },
  { clip: "run", move: "run", keys: 4, required: false },
  { clip: "attack", move: "attack", keys: 4, required: false, strikeKey: 2 },
  { clip: "stumble", move: "stumble", keys: 4, required: false },
  { clip: "crouch", move: "defend", keys: 4, required: false },
  { clip: "death", move: "death", keys: 4, required: false },
] as const;

export const rowKey = (clip: string, dir: Dir): string => `${clip}:${dir}`;

/**
 * Build a fresh plan. Pure — the caller owns ids, clocks and persistence,
 * because a function that reaches for `Date.now()` cannot be tested twice.
 */
export function planBuild(opts: {
  id: string;
  name: string;
  kind?: CharacterBuild["kind"];
  archetype?: CharacterBuild["archetype"];
  facings?: Dir[];
  clips?: readonly ClipSpec[];
  createdAt: number;
}): CharacterBuild {
  const name = opts.name.trim();
  if (!NAME_RE.test(name)) {
    throw new Error(`[build] "${name}" is not a publishable sheet name — lowercase, digits and _ only`);
  }
  const clips = [...(opts.clips ?? DEFAULT_CLIPS)];
  const bad = clips.find((c) => !KNOWN_CLIPS.has(c.clip));
  if (bad) {
    // Belt and braces over the `ClipName` typing: a plan deserialised from disk
    // has been through JSON and lost every compile-time guarantee it had.
    throw new Error(`[build] "${bad.clip}" is not a clip the animator packs — the importer would drop that row`);
  }
  if (!clips.some((c) => c.clip === "idle")) {
    throw new Error("[build] every character needs an `idle` clip — a sheet without one is dropped in silence");
  }
  const facings = [...(opts.facings ?? BUILD_DIRS)];
  if (!facings.includes("E")) {
    throw new Error("[build] E is the master's own facing and cannot be skipped");
  }

  const rows: Record<string, RowState> = {};
  for (const dir of facings) {
    for (const c of clips) {
      rows[rowKey(c.clip, dir)] = { clip: c.clip, dir, cells: [], verdicts: [], state: "pending" };
    }
  }
  return {
    id: opts.id,
    name,
    kind: opts.kind ?? "monster",
    archetype: opts.archetype ?? "melee",
    masters: {},
    facings,
    clips,
    state: "draft",
    rows,
    createdAt: opts.createdAt,
  };
}

/**
 * The order jobs should be enqueued in.
 *
 * ── WHY ORDER IS WORTH A FUNCTION ───────────────────────────────────────────
 * The scheduler in `app/api/comfy/generate/route.ts` runs ONE job at a time and
 * drains every parked job of the resident leg before switching, calling `/free`
 * exactly once on a real switch. Every job here is the `qwen` leg, so a build
 * that enqueues them together pays ZERO model swaps. Interleaving a Wan
 * in-between between two Qwen keyframes would cost a 13GB unload and reload
 * each way — the whole reason leg affinity exists.
 *
 * Within that: all of a facing's clips before the next facing's, because a
 * facing is the unit a human reviews, and `idle` first within each because it
 * is the clip that decides whether the sheet imports at all.
 */
export function jobOrder(build: CharacterBuild): RowState[] {
  const out: RowState[] = [];
  for (const dir of build.facings) {
    for (const c of build.clips) {
      const r = build.rows[rowKey(c.clip, dir)];
      if (r) out.push(r);
    }
  }
  return out;
}

/**
 * What a build still owes, in one sentence per problem.
 *
 * This is what the panel shows beside the publish button, and what the publish
 * gate consults. It reports EVERY blocker rather than the first, because a
 * user who fixes one thing and is handed the next one is being drip-fed.
 */
export function blockers(build: CharacterBuild): string[] {
  const out: string[] = [];
  for (const dir of build.facings) {
    if (!build.masters[dir]) out.push(`no approved master for facing ${dir}`);
  }
  for (const c of build.clips.filter((x) => x.required)) {
    for (const dir of build.facings) {
      const r = build.rows[rowKey(c.clip, dir)];
      if (!r || r.state !== "approved") {
        out.push(`${c.clip} ${dir} is required and is ${r?.state ?? "missing"}`);
      }
    }
  }
  for (const r of Object.values(build.rows)) {
    const blocked = r.verdicts.filter((v) => v.level === "reject").length;
    if (blocked) out.push(`${r.clip} ${r.dir} has ${blocked} cell(s) that failed the drift gate`);
    if (r.clipVerdict?.level === "reject") out.push(`${r.clip} ${r.dir}: ${firstFailure(r.clipVerdict)}`);
  }
  return out;
}

function firstFailure(v: QaVerdict): string {
  const f = v.checks.find((c) => !c.pass && !c.soft);
  return f?.why ?? "a clip-level check failed";
}

/**
 * Derive the build's state from its rows rather than storing it twice.
 *
 * A stored state and a derived one disagree the moment anything crashes
 * between the two writes, and the stored one always wins because it is the one
 * that got read. So there is only the derived one.
 */
export function deriveState(build: CharacterBuild): BuildState {
  if (build.state === "published" || build.state === "verified") return build.state;
  const rows = Object.values(build.rows);
  const need = build.facings.every((d) => build.masters[d]);
  if (!build.masters.E) return "draft";
  if (!need) return "master-approved";
  if (rows.some((r) => r.state === "queued" || r.state === "running")) return "generating";
  if (rows.every((r) => r.state === "pending")) return "planned";
  if (rows.every((r) => r.state === "approved")) return "assembled";
  return "review";
}

/**
 * WHAT A SHEET SET ON DISK COVERS, AGAINST THE SPEC ABOVE.
 *
 * `blockers()` answers this for a live `CharacterBuild` — a thing the planner
 * owns, in memory, mid-build. Nothing answered it for the artefact that
 * actually ships: the `public/sprites/*.json` a creature draws from. Those two
 * are not the same question, because a sheet set can reach `public/` without
 * ever having been a plan. Every creature in the game today did: jester,
 * beaver, frog, fish_feet, zombie and brute were all assembled by hand or by a
 * one-off prep script, and `DEFAULT_CLIPS` was written afterwards to describe
 * what they SHOULD have been.
 *
 * So this measures the gap instead of assuming it away. It is deliberately a
 * REPORT and not a gate: a partial import is a legitimate way to ship now that
 * `paintsFor` merges per clip (boot/sheets.ts), so "the brute has no death row"
 * is a fact to surface, not a build break. The one genuine error — no `idle`,
 * which makes `importedPaints` drop the whole creature in silence — is called
 * out as such, because that is the failure with a documented history of
 * shipping unnoticed for weeks.
 *
 * Pure, and typed against `ManifestRow`'s shape structurally rather than
 * importing `manifest.ts`, so this file keeps its no-node-imports guarantee and
 * both the runtime boot log and the forge's vitest can call it.
 */
/**
 * Clips an absent row costs NOTHING, because something downstream fills it.
 *
 * A report that flags by-design behaviour is a report people stop reading, and
 * two of the six spec clips are filled automatically:
 *
 *   run     → `alias()` in render/imported-paints.ts hands it `walk`'s frames
 *             BY REFERENCE and the animator plays them at the run frame rate.
 *             Publishing a real `run` row is the thing `mislabel.test.ts`
 *             rejects when it turns out to be walk's pixels again — which, on
 *             most source sheets, it is ("Walk / Run" is one caption).
 *   stumble → `withRecoil()` in render/cel-painter.ts derives a rocked-back
 *             pose from idle frame 0 for any family that hasn't posed one, and
 *             `CLIP_FALLBACK` degrades it to `idle` even if that fails.
 *
 * So the clips whose absence is a REAL hole are idle, walk, attack and death.
 * They are reported separately from the covered two, because "brute has no
 * death" is a work order and "brute has no run" is not.
 */
export const RUNTIME_COVERED: Readonly<Partial<Record<ClipName, string>>> = {
  run: "aliased from walk",
  stumble: "synthesized by withRecoil",
};

export interface SheetCoverage {
  /** Facings authored on disk, and the ones `BUILD_DIRS` expects but is missing. */
  facings: { authored: Dir[]; missing: Dir[] };
  /**
   * Spec clips with no row anywhere in the set, split by whether that costs
   * anything. `missing` is the work list; `covered` is filled downstream (see
   * `RUNTIME_COVERED`); `extra` is authored but outside the spec.
   */
  clips: { authored: ClipName[]; missing: ClipName[]; covered: ClipName[]; extra: string[] };
  /** Rows present ÷ rows the spec asks for (clips × facings). */
  rows: { have: number; want: number };
  /** No `idle` on any facing — `importedPaints` returns null and nothing draws. */
  fatal: boolean;
  /** One line, ready for a console log or a test name. */
  summary: string;
}

export function sheetCoverage(
  sheets: readonly { dir: Dir; rows: readonly { clip: string }[] }[],
  clips: readonly ClipSpec[] = DEFAULT_CLIPS,
  dirs: readonly Dir[] = BUILD_DIRS,
): SheetCoverage {
  const want = clips.map((c) => c.clip);
  const authoredDirs = [...new Set(sheets.map((s) => s.dir))];
  const seen = new Set(sheets.flatMap((s) => s.rows.map((r) => r.clip)));
  const authored = want.filter((c) => seen.has(c));
  const absent = want.filter((c) => !seen.has(c));
  const missing = absent.filter((c) => !RUNTIME_COVERED[c]);
  const covered = absent.filter((c) => RUNTIME_COVERED[c]);
  const extra = [...seen].filter((c) => !want.includes(c as ClipName));
  // Rows are counted per (clip, facing) — the unit the spec is written in and
  // the unit a facing-partial creature is short of. An S-only sheet with all
  // six clips is 6/18, not 6/6: the game renders it facing the camera while it
  // walks east, which is a real hole even though every clip "exists".
  let have = 0;
  for (const s of sheets) {
    for (const r of s.rows) if (want.includes(r.clip as ClipName)) have++;
  }
  const fatal = !seen.has("idle");
  const missingDirs = dirs.filter((d) => !authoredDirs.includes(d));
  const parts = [`${have}/${want.length * dirs.length} rows`, `facings ${authoredDirs.join("+") || "none"}`];
  if (missingDirs.length) parts.push(`no ${missingDirs.join("/")} art`);
  // The work list first and unqualified; the harmless absences last and marked,
  // so a skim reads the former and never mistakes the latter for a defect.
  if (missing.length) parts.push(`NO ${missing.join("/").toUpperCase()}`);
  if (extra.length) parts.push(`extra ${extra.join("/")}`);
  if (covered.length) parts.push(`(${covered.map((c) => `${c}: ${RUNTIME_COVERED[c]}`).join(", ")})`);
  if (fatal) parts.push("NO IDLE — the whole set is dropped");
  return {
    facings: { authored: authoredDirs, missing: missingDirs },
    clips: { authored, missing, covered, extra },
    rows: { have, want: want.length * dirs.length },
    fatal,
    summary: parts.join(" · "),
  };
}
