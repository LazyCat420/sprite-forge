/**
 * PROJECT REGISTRY — which games have a sprite forge, and where their art
 * lives. A "project" is any game folder with a tools/sprite-forge/ inside;
 * discovery is a scan, not a list, so a new game grows a forge by growing
 * the folder — nothing to register here.
 *
 * Every filesystem root the library route serves FROM or writes INTO comes
 * out of this file's resolvers, and `safeRel` is the one gate a browser-
 * supplied path must pass — the streaming route must never join paths on
 * its own.
 */
import { existsSync, readdirSync } from "node:fs";
import { join, normalize } from "node:path";

const GAMES_DIR = () => join(process.cwd(), "src", "game");

/** Every game with a sprite forge. The panel's project dropdown. */
export function listProjects() {
  let games = [];
  try {
    games = readdirSync(GAMES_DIR(), { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return [];
  }
  return games
    .filter((d) => existsSync(join(GAMES_DIR(), d.name, "tools", "sprite-forge")))
    .map((d) => ({ id: d.name, title: d.name.replace(/-/g, " ") }));
}

export function projectById(id) {
  return listProjects().find((p) => p.id === id) ?? null;
}

/** The forge root of a project: inbox/ sources/ work/ live under this. */
export function forgeRoot(projectId) {
  return join(GAMES_DIR(), projectId, "tools", "sprite-forge");
}

/**
 * The published-sheet dir. public/ is app-global, so projects share it by
 * convention today (pinball-knight publishes to public/sprites); a second
 * game that publishes must pick its own subdir here.
 */
export function publishedDir(projectId) {
  return projectId === "pinball-knight" ? join(process.cwd(), "public", "sprites") : null;
}

/** The roots a library asset may stream from, keyed by the token the URL carries. */
export function assetRoots(projectId) {
  const root = forgeRoot(projectId);
  return {
    inbox: join(root, "inbox"),
    sources: join(root, "sources"),
    work: join(root, "work", "comfy"),
  };
}

/**
 * Resolve a browser-supplied relative path against a named root, or null.
 * Rejects traversal (.. or absolute), symlink-free by construction (the
 * repo does not symlink art), and only ever serves .png.
 */
export function safeRel(projectId, rootKey, rel) {
  const roots = assetRoots(projectId);
  const root = roots[rootKey];
  if (!root) return null;
  const norm = normalize(String(rel));
  if (norm.startsWith("..") || norm.startsWith("/") || norm.includes("\0")) return null;
  if (!/\.png$/i.test(norm)) return null;
  const full = join(root, norm);
  if (!full.startsWith(root + "/")) return null;
  return full;
}
