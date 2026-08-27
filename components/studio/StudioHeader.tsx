"use client";

import React, { useEffect, useState } from "react";
import type { ClusterStatus } from "@/engine/cluster/spark-client";

export interface StudioHeaderProps {
  activeCharacter: string;
  onSelectCharacter: (char: string) => void;
  onNewCharacter: () => void;
}

export function StudioHeader({
  activeCharacter,
  onSelectCharacter,
  onNewCharacter,
}: StudioHeaderProps) {
  const [cluster, setCluster] = useState<ClusterStatus | null>(null);
  const [isWaking, setIsWaking] = useState(false);

  const fetchStatus = async () => {
    try {
      const res = await fetch("/api/cluster/status");
      if (res.ok) {
        const data = await res.json();
        setCluster(data.cluster);
      }
    } catch {
      /* offline */
    }
  };

  useEffect(() => {
    fetchStatus();
    const timer = setInterval(fetchStatus, 4000);
    return () => clearInterval(timer);
  }, []);

  const handleWake = async () => {
    setIsWaking(true);
    try {
      await fetch("/api/cluster/toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "on" }),
      });
      await fetchStatus();
    } catch (e) {
      console.error(e);
    } finally {
      setIsWaking(false);
    }
  };

  const goldUp = cluster?.goldSpark.reachable;
  const msiUp = cluster?.msiSpark.reachable;
  const anyClusterUp = goldUp || msiUp;

  return (
    <header
      style={{
        background: "#0d1117",
        borderBottom: "1px solid #21262d",
        padding: "12px 24px",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 12,
      }}
    >
      {/* Brand & Character Selector */}
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 22 }}>⚡</span>
          <span style={{ fontWeight: 700, fontSize: 18, color: "#f0f6fc", letterSpacing: "-0.02em" }}>
            SPRITE FORGE STUDIO
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: 12 }}>
          <span style={{ fontSize: 12, color: "#8b949e", textTransform: "uppercase", fontWeight: 600 }}>
            Character:
          </span>
          <select
            value={activeCharacter}
            onChange={(e) => {
              if (e.target.value === "__new__") onNewCharacter();
              else onSelectCharacter(e.target.value);
            }}
            style={{
              background: "#161b22",
              border: "1px solid #30363d",
              borderRadius: 6,
              color: "#c9d1d9",
              padding: "6px 12px",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            <option value="knight">🗡️ Pinball Knight</option>
            <option value="goblin">👺 Stiltneck Goblin</option>
            <option value="undead">🧟 Zombie Undead</option>
            <option value="beaver">🦫 Beaver Beast</option>
            <option value="__new__">+ Create New Character...</option>
          </select>
        </div>
      </div>

      {/* Cluster Health & Wake Controls */}
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {/* Node 1: Gold Spark */}
        <div
          style={{
            background: "#161b22",
            border: `1px solid ${goldUp ? "#238636" : "#30363d"}`,
            padding: "4px 10px",
            borderRadius: 6,
            fontSize: 12,
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: goldUp ? "#3fb950" : "#d29922" }} />
          <span style={{ color: "#c9d1d9", fontWeight: 500 }}>Gold Spark</span>
          <span style={{ color: goldUp ? "#8fdd9f" : "#8b949e", fontSize: 11 }}>
            {goldUp ? `${cluster?.goldSpark.vramFreeGiB ?? "?"}G free` : "standby"}
          </span>
        </div>

        {/* Node 2: MSI Spark */}
        <div
          style={{
            background: "#161b22",
            border: `1px solid ${msiUp ? "#238636" : "#30363d"}`,
            padding: "4px 10px",
            borderRadius: 6,
            fontSize: 12,
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: msiUp ? "#3fb950" : "#d29922" }} />
          <span style={{ color: "#c9d1d9", fontWeight: 500 }}>MSI Spark</span>
          <span style={{ color: msiUp ? "#8fdd9f" : "#8b949e", fontSize: 11 }}>
            {msiUp ? `${cluster?.msiSpark.vramFreeGiB ?? "?"}G free` : "standby"}
          </span>
        </div>

        {/* Wake / Start Button */}
        {!anyClusterUp && (
          <button
            onClick={handleWake}
            disabled={isWaking}
            style={{
              background: "#238636",
              border: "1px solid #2ea043",
              color: "#fff",
              borderRadius: 6,
              padding: "6px 12px",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {isWaking ? "Waking Cluster…" : "⚡ Wake ComfyUI"}
          </button>
        )}
      </div>
    </header>
  );
}
