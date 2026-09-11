/**
 * Server-side config for the /forge panel — where the backend lives on THIS
 * machine and what the user has chosen.
 *
 * Settings persist at ~/comfy/forge-settings.json — OUTSIDE the repo, on
 * purpose: the Civitai API key is a secret, deploy.sh ships the working
 * tree, and a tracked settings file would put the key in the image. The
 * whole panel is a dev-box tool; on a machine with no ~/comfy (the NAS
 * container) every API route reports the backend as absent and does
 * nothing else.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Root of the backend install. COMFY_HOME overrides for odd layouts. */
export function comfyHome() {
  return process.env.COMFY_HOME ?? join(homedir(), "comfy");
}

export function modelsDir() {
  return join(comfyHome(), "ComfyUI", "models");
}

/** Is a backend even installed on this box? Gates every route. */
export function backendPresent() {
  return existsSync(join(comfyHome(), "ComfyUI"));
}

const SETTINGS_FILE = () => join(comfyHome(), "forge-settings.json");

const DEFAULTS = {
  comfyUrl: "http://127.0.0.1:8188",
  civitaiToken: "",
  /** slotId → optionId for pick-one slots; absent = the recommended option. */
  chosen: {},
};

export function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(SETTINGS_FILE(), "utf8")) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  mkdirSync(comfyHome(), { recursive: true });
  writeFileSync(SETTINGS_FILE(), JSON.stringify(next, null, 1) + "\n", { mode: 0o600 });
  return next;
}

/**
 * Install state of a manifest option: is the file on disk at (about) the
 * right size? Within 1% covers safetensors metadata drift between the HF
 * tree listing and the actual download; a .part file is "downloading" and
 * a wildly short file is "broken" so the panel offers a re-download rather
 * than lying that it is ready.
 */
export function installState(option) {
  const path = join(modelsDir(), option.file);
  if (existsSync(path + ".part")) return { state: "partial", bytes: statSync(path + ".part").size };
  if (!existsSync(path)) return { state: "missing", bytes: 0 };
  const size = statSync(path).size;
  if (option.bytes && Math.abs(size - option.bytes) / option.bytes > 0.01 && size < option.bytes)
    return { state: "broken", bytes: size };
  return { state: "installed", bytes: size };
}
