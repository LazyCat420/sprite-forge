"use client";

/**
 * The backend tab: server status + settings + the model manager. Carried
 * over from the original single-page panel; the generation workspace moved
 * out, these stayed what they were — the "which weights, from where, at
 * what cost" surface the manifest renders.
 */
import React, { useEffect, useState } from "react";
import { S, fmtGB } from "./theme";
import type { Manifest } from "./types";

export function StatusCard({ m, onAction, busy }: { m: Manifest; onAction: (a: "start" | "stop") => void; busy: string | null }) {
  const c = m.comfy;
  const g = m.guard;
  return (
    <div style={S.card}>
      <h2 style={S.cardTitle}>
        backend
        {c.reachable ? (
          <span style={S.chip("#8fdd9f", "#16281c")}>up · ComfyUI {c.version}</span>
        ) : (
          <span style={S.chip("#dd8f8f", "#281616")}>down</span>
        )}
        {g?.running && <span style={S.chip("#8fdd9f", "#16281c")}>RAM guard on</span>}
        {c.reachable && g && !g.running && <span style={S.chip("#ffd9a0", "#2c2416")}>RAM guard NOT running</span>}
      </h2>
      {c.reachable ? (
        <p style={S.note}>
          {c.device} · VRAM {c.vramFreeGiB} / {c.vramTotalGiB} GiB free
          {m.ram?.availGiB != null && <> · RAM {m.ram.availGiB} / {m.ram.totalGiB} GiB available</>}
          {" "}· stop it when you are done — the card is shared
        </p>
      ) : (
        <p style={S.note}>server not answering at {m.settings.comfyUrl}</p>
      )}
      {g?.tripped && (
        <p style={{ ...S.note, color: "#dd8f8f" }}>
          RAM guard tripped {g.tripped.when}: {g.tripped.action} at {g.tripped.availGiB}GiB available. Free some RAM
          (close test runs / other sessions), then start the server again — starting clears this.
        </p>
      )}
      <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
        {!c.reachable && (
          <button style={{ ...S.btn, ...S.btnGreen }} disabled={busy !== null} onClick={() => onAction("start")}>
            {busy === "start" ? "starting… (~20s)" : "start server"}
          </button>
        )}
        {c.reachable && (
          <button style={S.btn} disabled={busy !== null} onClick={() => onAction("stop")}>
            {busy === "stop" ? "stopping…" : "stop server"}
          </button>
        )}
      </div>
    </div>
  );
}

export function SettingsCard({ m, onSave }: { m: Manifest; onSave: (patch: any) => void }) {
  const [url, setUrl] = useState(m.settings.comfyUrl);
  const [token, setToken] = useState("");
  useEffect(() => setUrl(m.settings.comfyUrl), [m.settings.comfyUrl]);
  return (
    <div style={S.card}>
      <h2 style={S.cardTitle}>settings</h2>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <label>
          <div style={S.note}>ComfyUI API URL</div>
          <input style={S.input} value={url} onChange={(e) => setUrl(e.target.value)} />
        </label>
        <label>
          <div style={S.note}>
            Civitai API key {m.settings.civitaiTokenSet ? "· one is stored" : "· none stored"} — needed only for the
            Civitai models below (free: civitai.com → account → API Keys)
          </div>
          <input
            style={S.input}
            type="password"
            placeholder={m.settings.civitaiTokenSet ? "••••••••  (leave blank to keep)" : "paste key"}
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </label>
      </div>
      <div style={{ marginTop: 10 }}>
        <button style={S.btn} onClick={() => onSave({ comfyUrl: url, ...(token ? { civitaiToken: token } : {}) })}>
          save settings
        </button>
      </div>
    </div>
  );
}

export function ModelsCard({
  m,
  dlJobs,
  onDownload,
  onChoose,
}: {
  m: Manifest;
  dlJobs: Record<string, { state: string; error?: string }>;
  onDownload: (id: string) => void;
  onChoose: (slotId: string, optionId: string) => void;
}) {
  return (
    <div style={S.card}>
      <h2 style={S.cardTitle}>models</h2>
      <p style={S.note}>
        REQUIRED slots must have one installed option or that leg will not run. Where a slot offers alternatives, the
        radio picks which one generation uses — installed alternatives swap instantly, no restart.
      </p>
      {m.legs.map((leg) => (
        <div key={leg.id} style={{ marginTop: 14 }}>
          <div style={{ color: "#e8e6df" }}>{leg.title}</div>
          <p style={S.note}>{leg.blurb}</p>
          {leg.slots.map((slot: any) => (
            <div key={slot.id} style={{ margin: "10px 0 0 0", padding: "8px 10px", background: "#0d0f14", borderRadius: 4 }}>
              <div>
                {slot.role}
                {slot.required ? (
                  <span style={S.chip("#ffd9a0", "#2c2416")}>required</span>
                ) : (
                  <span style={S.chip("#6a7080", "#171921")}>optional</span>
                )}
              </div>
              {slot.options.map((o: any) => {
                const st = o.install?.state ?? "missing";
                const job = dlJobs[o.id];
                const downloading = job?.state === "downloading" || st === "partial";
                const pct = downloading && o.bytes ? Math.min(99, Math.round(((o.install?.bytes ?? 0) / o.bytes) * 100)) : null;
                const isChosen =
                  slot.choice &&
                  ((m.settings.chosen[slot.id] ?? slot.options.find((x: any) => x.recommended)?.id) === o.id);
                return (
                  <div key={o.id} style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
                    {slot.choice && (
                      <input
                        type="radio"
                        name={slot.id}
                        checked={!!isChosen}
                        disabled={st !== "installed"}
                        title={st !== "installed" ? "download it first" : "use this one"}
                        onChange={() => onChoose(slot.id, o.id)}
                      />
                    )}
                    <span style={{ color: "#c8ccd4" }}>{o.name}</span>
                    <span style={{ color: "#6a7080" }}>{fmtGB(o.bytes)}</span>
                    <span style={{ color: "#6a7080" }}>{o.license}</span>
                    {o.recommended && <span style={S.chip("#9fd0ff", "#16202b")}>default</span>}
                    {o.kind === "civitai" && !m.settings.civitaiTokenSet && (
                      <span style={S.chip("#ffd9a0", "#2c2416")}>needs Civitai key</span>
                    )}
                    {st === "installed" && <span style={S.chip("#8fdd9f", "#16281c")}>installed</span>}
                    {st === "broken" && <span style={S.chip("#dd8f8f", "#281616")}>broken file — re-download</span>}
                    {job?.state === "error" && (
                      <span style={S.chip("#dd8f8f", "#281616")} title={job.error}>
                        failed: {job.error?.slice(0, 80)}
                      </span>
                    )}
                    {downloading ? (
                      <span style={S.chip("#9fd0ff", "#16202b")}>downloading{pct !== null ? ` ${pct}%` : "…"}</span>
                    ) : (
                      st !== "installed" && (
                        <button style={S.btn} onClick={() => onDownload(o.id)}>
                          download
                        </button>
                      )
                    )}
                    {o.note && <div style={{ ...S.note, flexBasis: "100%", marginLeft: slot.choice ? 22 : 0 }}>{o.note}</div>}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
