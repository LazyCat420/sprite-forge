"use client";

/**
 * The last mile: publish the inbox, then look at the creature ALIVE in the
 * dungeon. Everything upstream judges pictures; this judges the game.
 *
 * Two buttons because they are two different commitments. `publish` writes
 * tracked files under public/sprites/ (it is `npm run sprites`, the same
 * command by hand). `test in game` only reads — it launches the dungeon on
 * the real GPU, spawns three of one kind in the art-QA pose, and photographs
 * them. The verdict line that matters is `imported`: empty means a PAINTER
 * is still drawing this creature and the published art never arrived.
 */
import React, { useEffect, useState } from "react";
import { S, GREEN, AMBER, RED, GREY } from "./theme";
import { postJSON } from "./api";

type Kind = { id: string; label: string; icon: string };

export function InGameCard({ say }: { say: (s: string) => void }) {
  const [kinds, setKinds] = useState<Kind[]>([]);
  const [kind, setKind] = useState("croaker");
  const [aggro, setAggro] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [shots, setShots] = useState<string[]>([]);
  const [imported, setImported] = useState<string[] | null>(null);
  const [publishLog, setPublishLog] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/comfy/ingame?kinds=1")
      .then((r) => r.json())
      .then((j) => setKinds(j.kinds ?? []))
      .catch(() => {});
  }, []);

  const publish = async () => {
    setBusy("publish");
    setPublishLog(null);
    try {
      const j = await postJSON("/api/comfy/pipeline", { op: "publish" });
      setPublishLog(j.log ?? "");
      say(j.published?.length ? `published: ${j.published.join(", ")}` : "publish finished — no new sheets written");
    } catch (e: any) {
      say(e.message);
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy("test");
    setShots([]);
    setImported(null);
    try {
      const j = await postJSON("/api/comfy/ingame", { kind, aggro, shots: 5, every: 600 });
      setShots(j.shots ?? []);
      setImported(j.imported ?? []);
      say(j.imported?.length ? "captured — imported art is live" : "captured — but a PAINTER is drawing this one");
    } catch (e: any) {
      say(e.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={S.card}>
      <h2 style={S.cardTitle}>
        in game
        <span style={S.chip(GREY.fg, GREY.bg)}>the only honest test</span>
      </h2>
      <p style={S.note}>
        publish writes <code>public/sprites/</code> (tracked — it is <code>npm run sprites</code>); test spawns three of
        one kind in the real dungeon on the real GPU and photographs them.
      </p>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 10 }}>
        <button style={{ ...S.btn }} disabled={busy !== null} onClick={publish}>
          {busy === "publish" ? "publishing… (~90s)" : "publish inbox → game"}
        </button>
        <span style={{ ...S.note, margin: "0 4px" }}>then</span>
        <select style={{ ...S.input, width: 190 }} value={kind} onChange={(e) => setKind(e.target.value)}>
          {kinds.map((k) => (
            <option key={k.id} value={k.id}>
              {k.icon} {k.label}
            </option>
          ))}
        </select>
        <label style={{ ...S.note, display: "flex", alignItems: "center", gap: 4 }}>
          <input type="checkbox" checked={aggro} onChange={(e) => setAggro(e.target.checked)} />
          make them charge (walk cycle in motion)
        </label>
        <button style={{ ...S.btn, ...S.btnGreen }} disabled={busy !== null} onClick={test}>
          {busy === "test" ? "launching the dungeon… (~60s)" : "▶ test in game"}
        </button>
      </div>
      {imported !== null && (
        <p style={{ ...S.note, marginTop: 10 }}>
          {imported.length ? (
            <span style={S.chip(GREEN.fg, GREEN.bg)}>imported art live</span>
          ) : (
            <span style={S.chip(RED.fg, RED.bg)}>painter is drawing this — published art did not load</span>
          )}{" "}
          {imported.join(" · ")}
        </p>
      )}
      {shots.length > 0 && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
          {shots.map((s, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={i} src={s} alt={`frame ${i}`} style={{ width: 300, borderRadius: 4, border: "1px solid #23262f" }} />
          ))}
        </div>
      )}
      {publishLog && (
        <pre style={{ ...S.note, maxHeight: 180, overflow: "auto", background: "#0d0f14", padding: 8, borderRadius: 4, marginTop: 10 }}>
          {publishLog}
        </pre>
      )}
      <p style={{ ...S.note, marginTop: 8 }}>
        <span style={S.chip(AMBER.fg, AMBER.bg)}>reskins only</span> the game maps generated sheets onto existing
        monsters (croaker ← frog, rotortail ← beaver…). A brand-new creature needs its game tables first.
      </p>
    </div>
  );
}
