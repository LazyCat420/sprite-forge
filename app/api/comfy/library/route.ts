/**
 * The character library — every creature a project knows, with every piece
 * of art it already has, so the panel never needs a file manager:
 *
 *   GET ?project=<id>                    → roster + assets per character
 *   GET ?project=<id>&file=<root>:<rel>  → stream one PNG (inbox/sources/work)
 *   GET (bare)                          → projects + the active one
 *
 * A character is keyed by its SHEET name (frog, beaver, pinball_knight…);
 * the game roster joins in through IMPORTED_ART + KIND_INFO so the frog
 * row says "Croaker" and carries its blurb — which doubles as a prompt
 * hint. Roster kinds with no art still get a row: that is the "start
 * generating a spider" entry point. Art with no roster entry (don_quixote)
 * gets a row too — the scan is the truth about what exists.
 *
 * Assets come from four places, all read-only here: public/sprites/
 * (published — served statically), inbox/ (staged), sources/<name-date>/
 * (tracked originals), work/comfy/<job>/ (recent generations, grouped by
 * the job.json character tag).
 */
import { NextResponse } from "next/server";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { KIND_INFO, KIND_IDS } from "../../../../src/game/pinball-knight/bestiary";
import { KNOWN_CLIPS } from "../../../../src/game/pinball-knight/tools/sprite-forge/labels";
import type { ClipName } from "../../../../src/game/pinball-knight/engine/render/paint-types";
import { IMPORTED_ART } from "../../../../src/game/pinball-knight/boot/sheets";
import {
  assetRoots,
  listProjects,
  projectById,
  publishedDir,
  safeRel,
} from "../../../../src/game/pinball-knight/tools/sprite-forge/comfy/projects.mjs";
import { backendPresent, loadSettings } from "../../../../src/game/pinball-knight/tools/sprite-forge/comfy/forge-config.mjs";

export const dynamic = "force-dynamic";

type Asset = { label: string; url: string };
/**
 * A sub-folder's clip, when its name declares one — `clip_S_walk` → `walk`,
 * and a folder simply called `death` → `death`. The panel uses it to
 * pre-label the sheet-tray row, so it must come from `KNOWN_CLIPS` and never
 * from a guess: an unlabelled group is offered as "— pick a clip —", which is
 * the same rule the jobs board learned when a custom `death` action came up
 * filed as `walk`.
 */
function clipOf(group: string | null): string | null {
  if (!group) return null;
  const tail = group.toLowerCase().replace(/^clip[_-][sne][_-]/, "").replace(/^clip[_-]/, "");
  return KNOWN_CLIPS.has(tail as ClipName) ? tail : null;
}

type Character = {
  name: string;
  label: string;
  icon: string;
  blurb: string;
  kind: "player" | "monster" | "art-only";
  thumb: string | null;
  published: Asset[];
  inbox: Asset[];
  sources: { drop: string; group: string | null; clip: string | null; files: Asset[] }[];
  recent: { jobId: string; label: string; startedAt: number; frames: Asset[] }[];
};

const fileUrl = (project: string, root: string, rel: string) =>
  `/api/comfy/library?project=${project}&file=${root}:${encodeURIComponent(rel)}`;

/** sheet name → the game-roster identity it renders, if any. */
function rosterFor(project: string): Map<string, { label: string; icon: string; blurb: string; kind: "player" | "monster" }> {
  const m = new Map<string, { label: string; icon: string; blurb: string; kind: "player" | "monster" }>();
  if (project !== "pinball-knight") return m;
  m.set("pinball_knight", { label: "Pinball Knight", icon: "⚔️", blurb: "the player: an armored knight who curls into a pinball", kind: "player" });
  const sheetByKind = IMPORTED_ART as Record<string, string>;
  for (const kind of KIND_IDS) {
    const info = KIND_INFO[kind];
    m.set(sheetByKind[kind] ?? kind, { label: info.label, icon: info.icon, blurb: info.blurb, kind: "monster" });
  }
  return m;
}

function buildCharacters(project: string): Character[] {
  const roots = assetRoots(project);
  const chars = new Map<string, Character>();
  const roster = rosterFor(project);
  const get = (name: string): Character => {
    let c = chars.get(name);
    if (!c) {
      const r = roster.get(name);
      c = {
        name,
        label: r?.label ?? name.replace(/_/g, " "),
        icon: r?.icon ?? "🎨",
        blurb: r?.blurb ?? "",
        kind: r?.kind ?? "art-only",
        thumb: null,
        published: [],
        inbox: [],
        sources: [],
        recent: [],
      };
      chars.set(name, c);
    }
    return c;
  };

  // Roster first, so artless monsters still get their row.
  for (const name of roster.keys()) get(name);

  const parse = (file: string) => {
    const m = /^([a-z0-9_]+?)(?:-([SNE]))?\.png$/i.exec(file);
    return m ? { name: m[1], dir: m[2] ?? "E" } : null;
  };

  const pub = publishedDir(project);
  if (pub && existsSync(pub)) {
    for (const f of readdirSync(pub).filter((f) => f.endsWith(".png")).sort()) {
      const p = parse(f);
      if (!p) continue;
      const c = get(p.name);
      c.published.push({ label: `${p.dir} · published`, url: `/sprites/${f}` });
      c.thumb ??= `/sprites/${f}`;
    }
  }

  if (existsSync(roots.inbox)) {
    for (const f of readdirSync(roots.inbox).filter((f) => f.endsWith(".png")).sort()) {
      const p = parse(f);
      if (!p) continue;
      const c = get(p.name);
      c.inbox.push({ label: `${p.dir} · inbox`, url: fileUrl(project, "inbox", f) });
      c.thumb ??= fileUrl(project, "inbox", f);
    }
  }

  if (existsSync(roots.sources)) {
    for (const drop of readdirSync(roots.sources, { withFileTypes: true }).filter((d) => d.isDirectory())) {
      const m = /^([a-z0-9_]+)-(\d{4}-\d{2}-\d{2})$/.exec(drop.name);
      if (!m) continue;
      const c = get(m[1]);
      const pngs = (rel: string) =>
        readdirSync(join(roots.sources, drop.name, rel), { withFileTypes: true })
          .filter((f) => f.isFile() && f.name.endsWith(".png"))
          .map((f) => f.name)
          .sort()
          .map((f) => ({ label: f, url: fileUrl(project, "sources", `${drop.name}/${rel ? `${rel}/` : ""}${f}`) }));
      const push = (group: string | null, files: Asset[]) => {
        if (!files.length) return;
        c.sources.push({ drop: m[2], group, clip: clipOf(group), files });
        c.thumb ??= files[0].url;
      };
      push(null, pngs(""));
      // A DROP IS NOT FLAT, and the panel used to act as if it were.
      // A generated move-set files itself as `clip_<DIR>_<clip>/` folders
      // beside the masters, so a flat scan showed three masters and hid the
      // sixty-odd clip frames that are the actual work — the frames a
      // curation pass exists to choose between. One level down is enough:
      // deeper nesting is not a shape the forge writes.
      for (const sub of readdirSync(join(roots.sources, drop.name), { withFileTypes: true })) {
        if (sub.isDirectory()) push(sub.name, pngs(sub.name));
      }
    }
    for (const c of chars.values()) {
      c.sources.sort((a, b) => (a.drop !== b.drop ? (a.drop < b.drop ? 1 : -1) : (a.group ?? "").localeCompare(b.group ?? "")));
    }
  }

  if (existsSync(roots.work)) {
    for (const jobDir of readdirSync(roots.work, { withFileTypes: true }).filter((d) => d.isDirectory())) {
      let meta: any = {};
      try {
        meta = JSON.parse(readFileSync(join(roots.work, jobDir.name, "job.json"), "utf8"));
      } catch {
        /* CLI runs have no job.json — they stay unfiled */
      }
      if (!meta.character || meta.state !== "done") continue;
      const frames = readdirSync(join(roots.work, jobDir.name))
        .filter((f) => f.endsWith(".png"))
        .sort()
        .map((f) => ({ label: f, url: fileUrl(project, "work", `${jobDir.name}/${f}`) }));
      if (!frames.length) continue;
      const c = get(meta.character);
      c.recent.push({ jobId: jobDir.name, label: meta.label ?? meta.mode ?? jobDir.name, startedAt: meta.startedAt ?? 0, frames });
    }
    for (const c of chars.values()) c.recent.sort((a, b) => b.startedAt - a.startedAt).splice(8);
  }

  return [...chars.values()].sort((a, b) => {
    const rank = (c: Character) => (c.kind === "player" ? 0 : c.published.length || c.inbox.length || c.sources.length ? 1 : 2);
    return rank(a) - rank(b) || a.label.localeCompare(b.label);
  });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const projects = listProjects();
  const settings = loadSettings() as any;
  const project = url.searchParams.get("project") ?? settings.project ?? projects[0]?.id;
  if (!project || !projectById(project)) {
    return NextResponse.json({ projects, activeProject: null, characters: [] });
  }

  const file = url.searchParams.get("file");
  if (file) {
    const [root, ...relParts] = file.split(":");
    const full = safeRel(project, root, decodeURIComponent(relParts.join(":")));
    if (!full || !existsSync(full) || !statSync(full).isFile()) {
      return NextResponse.json({ error: "no such asset" }, { status: 404 });
    }
    let buf: Buffer = readFileSync(full);
    // ?w= — the same nearest-neighbour thumbnail the generate route serves,
    // for the same measured reason: a character with a full move-set on disk
    // is ~130 thumbnails, and at full size that is tens of megabytes of PNG
    // decode per render. The actions (→ init, → style, + sheet) all use the
    // unresized URL, so nothing downstream ever sees a shrunk frame.
    const w = Number(url.searchParams.get("w"));
    if (Number.isFinite(w) && w >= 16 && w <= 1024) {
      try {
        const importMod = new Function("p", "return import(p)");
        const mod = await importMod("canvas");
        const img = await mod.loadImage(buf);
        if (img.width > w) {
          const cv = mod.createCanvas(w, Math.round((img.height / img.width) * w));
          const ctx = cv.getContext("2d");
          ctx.imageSmoothingEnabled = true;
          ctx.drawImage(img, 0, 0, cv.width, cv.height);
          buf = cv.toBuffer("image/png");
        }
      } catch {
        // Fallback to unresized buffer
      }
    }
    return new NextResponse(new Uint8Array(buf), {
      headers: { "content-type": "image/png", "cache-control": "public, max-age=300" },
    });
  }

  return NextResponse.json({ projects, activeProject: project, characters: buildCharacters(project) });
}
