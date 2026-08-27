/**
 * ComfyUI Client for Sprite Forge targeting DGX Spark cluster.
 */

export async function uploadBase64Image(
  dataUrl: string,
  name = `init_${Date.now()}.png`,
  comfyUrl: string
): Promise<string> {
  const base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, "");
  const buffer = Buffer.from(base64Data, "base64");

  const formData = new FormData();
  formData.append("image", new Blob([buffer], { type: "image/png" }), name);
  formData.append("overwrite", "true");

  const res = await fetch(`${comfyUrl}/upload/image`, {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    throw new Error(`[comfy] /upload/image failed: ${res.status} ${await res.text()}`);
  }

  const json = await res.json();
  return json.subfolder ? `${json.subfolder}/${json.name}` : json.name;
}

export async function queuePrompt(
  graph: Record<string, any>,
  comfyUrl: string
): Promise<string> {
  const res = await fetch(`${comfyUrl}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: graph }),
  });

  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(`[comfy] /prompt rejected graph: ${JSON.stringify(data)}`);
  }
  return data.prompt_id;
}

export async function waitForPrompt(
  promptId: string,
  comfyUrl: string,
  timeoutMs = 60000,
  pollMs = 1000
): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${comfyUrl}/history/${promptId}`, { cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      const history = data[promptId];
      if (history) {
        if (history.status?.status_str === "error") {
          throw new Error(`[comfy] execution error: ${JSON.stringify(history.status.messages)}`);
        }
        if (history.outputs && Object.keys(history.outputs).length > 0) {
          return history;
        }
      }
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`[comfy] prompt ${promptId} timed out after ${timeoutMs / 1000}s`);
}

export async function fetchOutputImage(
  imageMeta: { filename: string; subfolder?: string; type?: string },
  comfyUrl: string
): Promise<Buffer> {
  const q = new URLSearchParams({
    filename: imageMeta.filename,
    subfolder: imageMeta.subfolder ?? "",
    type: imageMeta.type ?? "output",
  });
  const res = await fetch(`${comfyUrl}/view?${q}`);
  if (!res.ok) throw new Error(`[comfy] /view failed: ${res.status}`);
  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
}
