/**
 * DGX Spark Cluster Client for ComfyUI.
 */

export const GOLD_SPARK_URL = process.env.GOLD_SPARK_URL || "http://10.0.0.141:8188";
export const MSI_SPARK_URL = process.env.MSI_SPARK_URL || "http://10.0.0.103:8188";
export const SPARK_CONSOLE_URL = process.env.SPARK_CONSOLE_URL || "http://10.0.0.141:8800";

export interface NodeStatus {
  reachable: boolean;
  name: string;
  url: string;
  version?: string;
  device?: string;
  vramFreeGiB?: number;
  vramTotalGiB?: number;
}

export interface ClusterStatus {
  consoleReachable: boolean;
  goldSpark: NodeStatus;
  msiSpark: NodeStatus;
  activeService: "comfy" | "deepseek" | "none";
}

export async function probeNode(name: string, url: string): Promise<NodeStatus> {
  try {
    const res = await fetch(`${url}/system_stats`, { signal: AbortSignal.timeout(1500), cache: "no-store" });
    if (!res.ok) return { reachable: false, name, url };
    const s = await res.json();
    const d = s.devices?.[0] ?? {};
    return {
      reachable: true,
      name,
      url,
      version: s.system?.comfyui_version ?? "?",
      device: d.name ?? "?",
      vramFreeGiB: d.vram_free ? +(d.vram_free / 2 ** 30).toFixed(1) : undefined,
      vramTotalGiB: d.vram_total ? +(d.vram_total / 2 ** 30).toFixed(1) : undefined,
    };
  } catch {
    return { reachable: false, name, url };
  }
}

export async function getClusterStatus(): Promise<ClusterStatus> {
  const [goldSpark, msiSpark] = await Promise.all([
    probeNode("Gold Spark (Head · 128GB)", GOLD_SPARK_URL),
    probeNode("MSI Spark (Worker · 128GB)", MSI_SPARK_URL),
  ]);

  let consoleReachable = false;
  let activeService: "comfy" | "deepseek" | "none" = "none";

  try {
    const r = await fetch(`${SPARK_CONSOLE_URL}/api/status`, { signal: AbortSignal.timeout(1500), cache: "no-store" });
    if (r.ok) {
      consoleReachable = true;
      const s = await r.json();
      if (s.comfy_head?.running || s.comfy_worker?.running) {
        activeService = "comfy";
      } else if (s.deepseek?.running) {
        activeService = "deepseek";
      }
    }
  } catch {
    /* console offline */
  }

  return {
    consoleReachable,
    goldSpark,
    msiSpark,
    activeService,
  };
}

export async function toggleComfyService(onoff: "on" | "off"): Promise<boolean> {
  try {
    const res = await fetch(`${SPARK_CONSOLE_URL}/api/toggle/comfy_head/${onoff}`, {
      method: "POST",
      signal: AbortSignal.timeout(3000),
    });
    if (onoff === "on") {
      await fetch(`${SPARK_CONSOLE_URL}/api/toggle/comfy_worker/on`, {
        method: "POST",
        signal: AbortSignal.timeout(3000),
      }).catch(() => {});
    }
    return res.ok;
  } catch {
    return false;
  }
}

export async function selectActiveComfyTarget(): Promise<string> {
  try {
    const r1 = await fetch(`${GOLD_SPARK_URL}/system_stats`, { signal: AbortSignal.timeout(1000) });
    if (r1.ok) return GOLD_SPARK_URL;
  } catch {
    /* fallback */
  }

  try {
    const r2 = await fetch(`${MSI_SPARK_URL}/system_stats`, { signal: AbortSignal.timeout(1000) });
    if (r2.ok) return MSI_SPARK_URL;
  } catch {
    /* fallback */
  }

  return GOLD_SPARK_URL;
}

/**
 * Route specific jobs across Gold Spark (Queue 1) and MSI Spark (Queue 2)
 * for true parallel generation.
 */
export async function selectTargetForFacing(facing: "S" | "E" | "N" = "S"): Promise<string> {
  if (facing === "N") {
    // Try MSI Spark first for North angle to run concurrently with Gold Spark
    try {
      const r = await fetch(`${MSI_SPARK_URL}/system_stats`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return MSI_SPARK_URL;
    } catch {
      /* fallback to Gold Spark */
    }
  }

  return selectActiveComfyTarget();
}
