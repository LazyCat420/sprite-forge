/**
 * DOES THE ART IN `public/sprites/` ACTUALLY REACH THE GAME?
 *
 * The forge's own report says a sheet sliced, censused and published cleanly.
 * It cannot say whether `applyImportedArt` will USE it — that call drops a
 * creature's whole sheet set, silently and by design, whenever `importedPaints`
 * returns null: no playable rows, or no `idle` on the facing the others fall
 * back to. The monster then draws with its painter and the only trace is a
 * boot log that never printed.
 *
 * The zombie shipped in exactly that state: six labelled rows, 24 frames, a
 * COMPETITIVE verdict, `public/sprites/zombie-E.{png,json}` on disk — and rows
 * named `walk/walk/attack/attack/death/death`, so no idle, so null, so the
 * painter. Nothing failed. This is the test that fails.
 *
 * It reads the sheet names out of `boot/sheets.ts` rather than restating them:
 * a mirror of that table would pass while the table it mirrors went stale,
 * which is the same shape of defect one level up.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { loadImage } from "canvas";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { installSpriteTestDom } from "../../testkit/atlas-census";
import { importedPaints, type ImportedSheet } from "../../render/imported-paints";
import type { SheetManifest } from "./manifest";
import { BUILD_DIRS, DEFAULT_CLIPS, sheetCoverage } from "./build-plan";
import type { Dir } from "../../engine/render/paint-types";

const PUBLIC = join(__dirname, "..", "..", "..", "..", "..", "public", "sprites");
const SHEETS_TS = join(__dirname, "..", "..", "boot", "sheets.ts");

/** The facings the loader asks for, in `boot/sheets.ts`'s order. */
const DIRS: Dir[] = ["S", "N", "E"];

const KNIGHT_SHEETS_TS = join(__dirname, "..", "..", "render", "knight-sheets.ts");

/** `IMPORTED_ART` from the source of truth: SheetKey → sheet name. */
function importedArt(): [string, string][] {
  const src = readFileSync(SHEETS_TS, "utf8");
  const block = /const IMPORTED_ART[^=]*=\s*\{([^}]*)\}/.exec(src);
  if (!block) throw new Error("[forge] could not find IMPORTED_ART in boot/sheets.ts");
  return [...block[1].matchAll(/(\w+)\s*:\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]);
}

/**
 * `PLAYABLE` — the character-select roster, which this gate did NOT cover.
 *
 * `IMPORTED_ART` is the MONSTER map, so every check below ran on the roster the
 * player fights and none of it on the roster the player IS. A player sheet fails
 * exactly the same way a monster sheet does — `importedPaints` returns null
 * without an `idle` and the null is silent by design — and that is precisely how
 * stiltneck shipped invisible for weeks. Offering a character on a select screen
 * makes the silence worse, not better: the player picks Mario, confirms, and
 * stays the knight with nothing on screen saying why.
 */
function playable(): [string, string][] {
  const src = readFileSync(KNIGHT_SHEETS_TS, "utf8");
  const block = /const PLAYABLE[^=]*=\s*\[([\s\S]*?)\];/.exec(src);
  if (!block) throw new Error("[forge] could not find PLAYABLE in render/knight-sheets.ts");
  const rows = [...block[1].matchAll(/sheet:\s*(?:"([^"]+)"|(\w+))/g)];
  return rows.map((m) => {
    // The default entry names the sheet through DEFAULT_PLAYER_SHEET rather
    // than a literal, so resolve that one constant rather than skipping it —
    // skipping would leave the DEFAULT character as the only unchecked one.
    const name = m[1] ?? /const DEFAULT_PLAYER_SHEET\s*=\s*"([^"]+)"/.exec(src)?.[1];
    if (!name) throw new Error(`[forge] could not resolve a PLAYABLE sheet name from ${m[0]}`);
    return [`player:${name}`, name] as [string, string];
  });
}

let restore = (): void => {};
beforeAll(() => { restore = installSpriteTestDom(); });
afterAll(() => { restore(); });

describe("published sheets", () => {
  it("every kind in IMPORTED_ART loads into playable paints", async () => {
    await expectRosterLoads(importedArt(), "IMPORTED_ART");
  }, 120_000);

  it("every character in PLAYABLE loads into playable paints", async () => {
    // Same gate, the other roster. See `playable()` for why it needs one.
    await expectRosterLoads(playable(), "PLAYABLE");
  }, 120_000);

  /**
   * EVERY SIDECAR CARRIES ITS PNG'S OWN CONTENT HASH.
   *
   * `versioned()` (render/imported-paints.ts) puts this in the image's URL so a
   * re-exported sheet is a NEW url. Without it that function falls back to the
   * sheet's DIMENSIONS — and a re-export at the same size then keeps the same
   * url while nginx serves the PNG `max-age=1y, immutable`. A returning player
   * gets a fresh sidecar cut against a year-old image: the new rects land on the
   * old art, the loader's size check sees two matching sizes and passes it, and
   * nothing anywhere reports a problem.
   *
   * That was the state of 41 of the 43 published manifests: only mario's had a
   * hash, written by hand after the bug bit there. The publisher writes one for
   * every sheet now (`inbox.test.ts`), and this is the gate that keeps it true —
   * it reads the PNG and re-derives the tag, so a hand-edited or half-published
   * pair fails here rather than in someone's browser a week later.
   */
  it("every published sidecar's hash matches its own PNG", () => {
    const files = (readdirSync(PUBLIC) as string[]).filter((f: string) => f.endsWith(".json"));
    expect(files.length, "public/sprites has no sidecars — did the path move?").toBeGreaterThan(0);
    const stale: string[] = [];
    for (const f of files) {
      const manifest = JSON.parse(readFileSync(join(PUBLIC, f), "utf8")) as SheetManifest;
      const png = join(PUBLIC, manifest.image.replace(/^\/sprites\//, "").replace(/\?.*$/, ""));
      if (!existsSync(png)) {
        stale.push(`${f}: names ${manifest.image}, which is not in public/sprites`);
        continue;
      }
      const want = createHash("sha256").update(readFileSync(png)).digest("hex").slice(0, 12);
      if (manifest.hash !== want) {
        stale.push(`${f}: hash ${manifest.hash ?? "MISSING"} but its PNG hashes to ${want}`);
      }
    }
    expect(
      stale,
      `sidecars out of step with their art — re-run \`npm run sprites\`:\n  ${stale.join("\n  ")}`,
    ).toEqual([]);
  }, 60_000);

  async function expectRosterLoads(art: [string, string][], label: string): Promise<void> {
    expect(art.length, `${label} parsed as empty — did the table's shape change?`)
      .toBeGreaterThan(0);

    for (const [key, name] of art) {
      const sheets: ImportedSheet[] = [];
      for (const dir of DIRS) {
        const jsonPath = join(PUBLIC, `${name}-${dir}.json`);
        if (!existsSync(jsonPath)) continue;
        const manifest = JSON.parse(readFileSync(jsonPath, "utf8")) as SheetManifest;
        const image = await loadImage(join(PUBLIC, `${name}-${dir}.png`));
        // The same size check the loader runs — a re-export at another size
        // shifts every cell rect and falls back to the painter at runtime.
        const [w, h] = manifest.source;
        expect(Math.abs(image.width - w), `${name}-${dir}: sheet is ${image.width}x${image.height}, manifest says ${w}x${h} — re-run \`npm run sprites\``)
          .toBeLessThanOrEqual(2);
        expect(Math.abs(image.height - h)).toBeLessThanOrEqual(2);
        sheets.push({ manifest, image: image as unknown as CanvasImageSource });
      }
      expect(sheets.length, `${key}: ${label} points at "${name}" but public/sprites has no such sheet`)
        .toBeGreaterThan(0);

      const paints = importedPaints(sheets);
      expect(
        paints,
        `${key}: "${name}" publishes ${sheets.length} sheet(s) that produce NO playable paints — ` +
          `the game will silently keep the painter. Every facing's rows: ` +
          sheets.map((s) => `${s.manifest.dir}=[${s.manifest.rows.map((r) => r.clip).join(",")}]`).join(" ") +
          `. The usual cause is no "idle" row.`,
      ).not.toBeNull();
      // idle is what the animator lands on for any clip an actor does not
      // author, so an empty one is a frozen monster rather than a missing clip.
      for (const dir of DIRS) {
        expect(paints?.[dir].idle?.length, `${key}: facing ${dir} has an empty idle`).toBeGreaterThan(0);
      }
    }
  }

  /**
   * THE STANDING COVERAGE REPORT — what every published creature still owes
   * `DEFAULT_CLIPS`, printed as a table rather than asserted.
   *
   * A pass/fail gate here would be wrong today and wrong on purpose: the whole
   * roster predates the spec (`build-plan.ts` was written to describe what
   * these sheets should have been), and `paintsFor` now merges imported clips
   * over the painter's, so a partial set is a supported way to ship rather than
   * a broken one. Failing the suite would say "delete the brute", which is not
   * the answer.
   *
   * What it DOES assert is the one thing that is unambiguously broken: a set
   * with no `idle` is dropped whole and in silence. `expectRosterLoads` already
   * catches that from the other direction; this states it in the spec's own
   * vocabulary so the two can't drift.
   *
   * The value is the printout. "brute: 3/18 rows · facings S · no run/stumble/
   * death" is the sentence that turns a vague "the monsters don't do much" into
   * a work list, and it re-prints itself on every run, so it cannot go stale
   * the way a hand-written TODO does.
   */
  it("reports each published set's coverage against DEFAULT_CLIPS", () => {
    const lines: string[] = [];
    for (const [key, name] of [...importedArt(), ...playable()]) {
      const manifests: SheetManifest[] = [];
      for (const dir of DIRS) {
        const p = join(PUBLIC, `${name}-${dir}.json`);
        if (existsSync(p)) manifests.push(JSON.parse(readFileSync(p, "utf8")) as SheetManifest);
      }
      if (!manifests.length) continue;
      const cov = sheetCoverage(manifests);
      lines.push(`  ${key.padEnd(16)} ${cov.summary}`);
      expect(cov.fatal, `${key}: no idle row — importedPaints drops the whole set`).toBe(false);
    }
    expect(lines.length).toBeGreaterThan(0);
    console.info(`\n[forge] published coverage vs DEFAULT_CLIPS (${DEFAULT_CLIPS.length} clips x ${BUILD_DIRS.length} facings):\n${lines.join("\n")}\n`);
  }, 60_000);
});
