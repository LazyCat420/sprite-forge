/**
 * THE ORACLE — what the TypeScript says, written down so the Python can be held
 * to it.
 *
 *   node src/game/pinball-knight/tools/sprite-forge/oracle.mjs
 *
 * Runs grid + slice + matte over the shipped sheets and rewrites
 * `python/tests/typescript-oracle.json`, which `test_parity.py` pins against.
 *
 * WHY A SEPARATE TOOL. The port must never pin numbers it produced itself — a
 * probe that sets its own context proves nothing, and a re-pin done by pasting
 * pytest's "actual" turns the whole suite into a tautology. The TS is the
 * oracle; this is the only sanctioned way to move a pin.
 *
 * WHEN TO RUN IT. A sheet in `public/sprites/` was regenerated and the parity
 * tests went red. Run this, read the diff — a factor or a cell rect moving when
 * you only meant to redraw art is itself the finding — then commit both.
 *
 * It does NOT compare against `public/sprites/<name>-S.json`. That manifest is
 * the ADOPTED geometry, which for a sheet with a `cells` override in its sidecar
 * (jester, beaver) is `equalCells` output, not what the slicer found.
 */
import { createRequire } from "module";
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const { createCanvas, loadImage } = require("canvas");

const HERE = dirname(fileURLToPath(import.meta.url));
const REF = join(HERE, "../../../../../public/sprites");
const OUT = join(HERE, "python/tests/typescript-oracle.json");

const SHEETS = ["jester", "beaver", "frog"];

// The pipeline is TypeScript; bundle it to one ESM file and import that. esbuild
// is already a devDependency (see scripts/lib/card-harness.mjs for the pattern).
const bundle = await build({
  stdin: {
    contents: `export { detectPixelGrid } from "./grid";
               export { sliceSheet } from "./slice";
               export { matte, rgbHex } from "./matte";`,
    resolveDir: HERE,
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  external: ["canvas"],
});

const mod = await import(
  "data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64")
);
const { detectPixelGrid, sliceSheet, matte, rgbHex } = mod;

async function raw(path) {
  const img = await loadImage(path);
  const c = createCanvas(img.width, img.height);
  c.getContext("2d").drawImage(img, 0, 0);
  return {
    data: c.getContext("2d").getImageData(0, 0, img.width, img.height).data,
    width: img.width,
    height: img.height,
  };
}

const out = {};
for (const name of SHEETS) {
  const r = await raw(join(REF, `${name}-S.png`));
  const manifest = JSON.parse(readFileSync(join(REF, `${name}-S.json`), "utf8"));
  const boxes = manifest.rows.flatMap((row) => row.cells);
  const g = detectPixelGrid(r, boxes);
  const top = [...g.scores].sort((a, b) => b.confidence - a.confidence)[0];
  const rows = sliceSheet(r.data, r.width, r.height);
  out[name] = {
    shape: rows.map((x) => x.cells.length),
    cells: rows.flatMap((x) => x.cells),
    factor: top.factor,
    confidence: +(top.confidence * 100).toFixed(3),
    purity: +(g.cellPurity * 100).toFixed(3),
    gridded: g.gridded,
  };
  console.log(
    `${name}: ×${top.factor} at ${out[name].confidence}% · purity ${out[name].purity}% · ` +
      `rows ${out[name].shape.join("/")}`,
  );
}

// The raw pre-matte frog — the fixture the matte parity test keys off.
const rawFrog = await raw(join(HERE, "inbox/frog-S.png"));
const m = matte(rawFrog.data, rawFrog.width, rawFrog.height);
out["raw-frog-matte"] = {
  bg: rgbHex(m.report.bg),
  bgConfidence: +(m.report.bgConfidence * 100).toFixed(3),
  keyedPct: +(m.report.keyedPct * 100).toFixed(3),
  pockets: m.report.enclosed.length,
  failures: m.report.failures,
};
console.log(
  `raw frog matte: bg ${out["raw-frog-matte"].bg} · keyed ` +
    `${out["raw-frog-matte"].keyedPct}% · ${out["raw-frog-matte"].pockets} pockets`,
);

writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
console.log(`\nwrote ${OUT}`);
