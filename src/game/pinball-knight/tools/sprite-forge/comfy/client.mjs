/**
 * ComfyUI API client — the whole backend contract in one file.
 *
 * The server is ComfyUI running headless at ~/comfy (see README.md here).
 * Its native API is small and stable; this speaks it directly rather than
 * through an SDK, because the surface we use is six endpoints:
 *
 *   POST /prompt          submit an API-format graph, returns {prompt_id}
 *   GET  /history/{id}    per-prompt status + output filenames when done
 *   GET  /view            fetch an output image (raw PNG — never the lossy
 *                         webp preview; frames must be pixel-exact)
 *   POST /upload/image    push an init image into the server's input dir
 *   GET  /object_info     node schemas — used to FAIL LOUDLY when a node
 *                         class this driver builds is missing or renamed
 *   GET  /system_stats    liveness + VRAM
 *   POST /interrupt       stop the RUNNING prompt (there is no cancel-by-id;
 *                         check /queue first — see interrupt())
 *   GET  /queue           running + pending prompt ids, full payloads
 *   POST /free            drop cached models — the 24GB card cannot hold the
 *                         Qwen and Wan stacks resident at once
 *
 * COMPLETION is still polled via /history: a poll survives a dev-server
 * reload and a dropped socket, so it stays the source of truth for "done".
 * PROGRESS rides the websocket (watchProgress below) because that is the
 * only place ComfyUI reports per-node state — but it is advisory: job state
 * must key off /history, never off progress traffic, which is documented to
 * trail completion (ComfyUI#9330).
 */

/**
 * Resolved per call, not at import: the /forge panel's API routes point
 * this at the user's configured URL via setComfyUrl() after reading
 * settings, and the CLI keeps its env/default behaviour.
 */
let configured = null;
export function setComfyUrl(url) {
  configured = url || null;
}
const BASE = {
  toString: () => configured ?? process.env.COMFY_URL ?? "http://127.0.0.1:8188",
};

export async function systemStats() {
  const r = await fetch(`${BASE}/system_stats`);
  if (!r.ok) throw new Error(`[comfy] ${BASE}/system_stats -> ${r.status}. Is the server up? Start it with ~/comfy/run.sh -d`);
  return r.json();
}

/**
 * Assert every node class the graph uses actually exists on the server.
 *
 * A renamed core node (it happens across ComfyUI releases) otherwise
 * surfaces as an opaque 400 from /prompt. This turns it into "node X is
 * missing — update graphs.mjs or the server" BEFORE anything is queued.
 */
export async function assertNodes(graph) {
  const r = await fetch(`${BASE}/object_info`);
  if (!r.ok) throw new Error(`[comfy] /object_info -> ${r.status}`);
  const known = await r.json();
  const missing = [...new Set(Object.values(graph).map((n) => n.class_type))].filter((c) => !known[c]);
  if (missing.length) {
    throw new Error(
      `[comfy] server is missing node class(es): ${missing.join(", ")}.\n` +
        `Core nodes: the ComfyUI checkout at ~/comfy/ComfyUI may be older/newer than this driver expects.\n` +
        `GGUF nodes: is custom_nodes/ComfyUI-GGUF installed and did the server start clean? Check ~/comfy/comfy.log`,
    );
  }
}

/** Upload an init image; returns the server-side name LoadImage expects. */
export async function uploadImage(path, name) {
  const { readFile } = await import("node:fs/promises");
  const buf = await readFile(path);
  const fd = new FormData();
  fd.append("image", new Blob([buf], { type: "image/png" }), name);
  fd.append("overwrite", "true");
  const r = await fetch(`${BASE}/upload/image`, { method: "POST", body: fd });
  if (!r.ok) throw new Error(`[comfy] upload of ${path} failed: ${r.status} ${await r.text()}`);
  const j = await r.json();
  return j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
}

/** @param {Record<string, any>} graph @param {{clientId?: string|null}} [opts] */
export async function queuePrompt(graph, { clientId = null } = {}) {
  // client_id routes this prompt's websocket events to watchProgress's
  // socket — without it ComfyUI only broadcasts global queue counts (the
  // Krita plugin's founding bug, krita-ai-diffusion#2059).
  const body = clientId ? { prompt: graph, client_id: clientId } : { prompt: graph };
  const r = await fetch(`${BASE}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok || j.error) {
    // node_errors carries per-node validation detail — surface it whole.
    throw new Error(`[comfy] /prompt rejected the graph: ${JSON.stringify(j, null, 1)}`);
  }
  return j.prompt_id;
}

/**
 * Stop work on a prompt. ComfyUI has no cancel-by-id: /interrupt kills
 * whatever is RUNNING and /queue{delete} removes PENDING entries, so the
 * caller has to look first. The check-then-act race (it finishes or starts
 * between the look and the kill) is inherent to the protocol (#8835) —
 * both outcomes are benign: a stray interrupt of the next prompt is the
 * one hazard, so only interrupt when the id matches queue_running.
 */
export async function cancelPrompt(promptId) {
  const q = await queueState();
  if (q.running.some((p) => p.promptId === promptId)) {
    const r = await fetch(`${BASE}/interrupt`, { method: "POST" });
    if (!r.ok) throw new Error(`[comfy] /interrupt -> ${r.status}`);
    return "interrupted";
  }
  const r = await fetch(`${BASE}/queue`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ delete: [promptId] }),
  });
  if (!r.ok) throw new Error(`[comfy] /queue delete -> ${r.status}`);
  return "dequeued";
}

/** Running + pending prompts. Entries are [number, prompt_id, graph, extra…]. */
export async function queueState() {
  const r = await fetch(`${BASE}/queue`);
  if (!r.ok) throw new Error(`[comfy] /queue -> ${r.status}`);
  const j = await r.json();
  const strip = (e) => ({ promptId: e[1] });
  return {
    running: (j.queue_running ?? []).map(strip),
    pending: (j.queue_pending ?? []).map(strip),
  };
}

/**
 * Drop cached models. The card cannot hold the Qwen and Wan stacks at once,
 * and ComfyUI keeps everything it ever loaded; call this when SWITCHING
 * legs, never routinely — the price is the next run going cold (~450s Wan).
 */
export async function freeMemory() {
  const r = await fetch(`${BASE}/free`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ unload_models: true, free_memory: true }),
  });
  if (!r.ok) throw new Error(`[comfy] /free -> ${r.status}`);
}

/**
 * Per-node progress + live sampler previews over the websocket.
 *
 * Advisory by contract: waitFor()/history stays the authority on done/error.
 * Uses the global WebSocket (Node 22+, every browser); where it is missing
 * this becomes a no-op and the caller simply has no progress bar. Returns
 * a close() function; the caller closes when history reports terminal.
 *
 * onProgress({node, value, max}) fires per sampler step and node change;
 * onPreview(buf, mime) fires with the latest live preview image IF the
 * server was started with --preview-method (binary frame: 4-byte type
 * big-endian [1 = image], 4-byte format [1 JPEG, 2 PNG], then the bytes).
 */
export function watchProgress(promptId, clientId, { onProgress, onPreview } = {}) {
  const WS = globalThis.WebSocket;
  if (!WS) return () => {};
  const wsUrl = `${BASE}`.replace(/^http/, "ws") + `/ws?clientId=${clientId}`;
  let ws;
  try {
    ws = new WS(wsUrl);
  } catch {
    return () => {};
  }
  ws.binaryType = "arraybuffer";
  ws.onmessage = (ev) => {
    if (typeof ev.data === "string") {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      const d = msg.data ?? {};
      if (d.prompt_id && d.prompt_id !== promptId) return;
      if (msg.type === "progress" && onProgress) {
        onProgress({ node: d.node ?? null, value: d.value ?? 0, max: d.max ?? 1 });
      } else if (msg.type === "executing" && onProgress && d.node) {
        onProgress({ node: d.node, value: 0, max: 1 });
      }
    } else if (onPreview && ev.data instanceof ArrayBuffer && ev.data.byteLength > 8) {
      const view = new DataView(ev.data);
      if (view.getUint32(0) === 1) {
        const mime = view.getUint32(4) === 2 ? "image/png" : "image/jpeg";
        onPreview(Buffer.from(ev.data, 8), mime);
      }
    }
  };
  ws.onerror = () => {};
  return () => {
    try {
      ws.close();
    } catch {
      /* already dead */
    }
  };
}

/**
 * Poll until the prompt leaves the queue, then return its history entry.
 * Throws with the server's own error payload on execution failure — a
 * failed sampler run must never be reported as "no outputs".
 */
export async function waitFor(promptId, { pollMs = 500, timeoutMs = 30 * 60_000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const r = await fetch(`${BASE}/history/${promptId}`);
    if (r.ok) {
      const h = (await r.json())[promptId];
      if (h) {
        const status = h.status?.status_str;
        if (status === "error") {
          const msgs = (h.status?.messages ?? []).filter(([k]) => k === "execution_error").map(([, v]) => v);
          throw new Error(`[comfy] execution failed:\n${JSON.stringify(msgs, null, 1)}`);
        }
        if (h.outputs && Object.keys(h.outputs).length) return h;
      }
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`[comfy] prompt ${promptId} still running after ${timeoutMs / 1000}s — interrupt with POST ${BASE}/interrupt`);
    await new Promise((res) => setTimeout(res, pollMs));
  }
}

/** Every image a finished prompt produced, as {filename, subfolder, type}. */
export function outputImages(history) {
  return Object.values(history.outputs).flatMap((o) => o.images ?? []).filter((i) => i.type === "output");
}

/** Fetch one output image as a Buffer (raw PNG, no preview transcode). */
export async function fetchImage({ filename, subfolder, type }) {
  const q = new URLSearchParams({ filename, subfolder: subfolder ?? "", type: type ?? "output" });
  const r = await fetch(`${BASE}/view?${q}`);
  if (!r.ok) throw new Error(`[comfy] /view ${filename} -> ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
