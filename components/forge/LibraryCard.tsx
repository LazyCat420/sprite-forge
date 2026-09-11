"use client";

/**
 * The character library — the roster with everything each creature already
 * has, so starting work never involves a file manager: pick the project,
 * pick the character, click any existing art straight into the init or
 * style slot, or into the sheet tray. While a character is selected, every
 * generation files under it (the job tag is what the library's "recent"
 * group scans), and the sheet tab pre-names its stage after it.
 *
 * ── FINISHED ART HAS TO BE EDITABLE FROM HERE ───────────────────────────
 * Generation and curation used to be split by accident: only a LIVE job
 * card could put frames in the sheet tray, so the moment a run's frames
 * were kept — or the dev server was restarted — the whole move-set became
 * a gallery. The frames were on disk and visible and there was no way to
 * pick between them. Every frame group in this card now carries the same
 * clip picker and `+ sheet` the jobs board has, which is what makes a
 * curation pass a thing you do in the panel instead of a thing I do for
 * you in a script.
 */
import React, { useState } from "react";
import { S, AMBER, BLUE, GREY } from "./theme";
import type { LibraryCharacter, LibraryState } from "./types";
import { CLIP_NAMES } from "./types";

/**
 * The thumbnail URL for an asset — a 112px render from the library route,
 * which is the only place that can serve one. `/sprites/*` is a static file
 * with no resizer, so it is left alone.
 */
const thumbUrl = (url: string) => (url.includes("/api/comfy/library") ? `${url}&w=112` : url);

function AssetThumb({
  label,
  url,
  onInit,
  onStyle,
  onSheet,
  sheetProps,
}: {
  label: string;
  url: string;
  onInit: (url: string) => void;
  onStyle: (url: string) => void;
  /** Absent for whole-sheet art (published/inbox): a sheet is not a frame. */
  onSheet?: (url: string) => void;
  sheetProps?: React.ButtonHTMLAttributes<HTMLButtonElement>;
}) {
  return (
    <div style={{ textAlign: "center" }} title={label}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {/* A full move-set is ~130 thumbnails and each one is a server-side
          resize; loading them all on mount left half the shelf blank while the
          box churned. Lazy + async means only what is scrolled to is paid for. */}
      <img
        src={thumbUrl(url)}
        alt={label}
        loading="lazy"
        decoding="async"
        style={{ width: 56, height: 56, objectFit: "contain", background: "#fff", borderRadius: 3 }}
      />
      <div style={{ display: "flex", gap: 2, justifyContent: "center", marginTop: 2 }}>
        <button style={{ ...S.btn, fontSize: 10, padding: "0 5px" }} title="use as the init frame" onClick={() => onInit(url)}>
          → init
        </button>
        <button style={{ ...S.btn, ...S.btnGhost, fontSize: 10, padding: "0 5px" }} title="use as the style ref" onClick={() => onStyle(url)}>
          → style
        </button>
        {onSheet && (
          <button
            style={{ ...S.btn, fontSize: 10, padding: "0 5px", ...(sheetProps?.disabled ? { opacity: 0.45, cursor: "not-allowed" } : {}) }}
            {...sheetProps}
            onClick={() => onSheet(url)}
          >
            + sheet
          </button>
        )}
      </div>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 8 }}>
      <div style={S.note}>{title}</div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4 }}>{children}</div>
    </div>
  );
}

/**
 * A folder of frames with its own clip label — the curation unit.
 *
 * The clip is a DECISION, not a default: a folder that does not name a known
 * clip opens on "— pick a clip —" and both add buttons stay disabled until
 * one is chosen, exactly as the jobs board does. Filing frames under a
 * plausible-but-wrong row is the failure this shape exists to prevent.
 */
function FrameGroup({
  title,
  files,
  clip: declared,
  facing,
  onInit,
  onStyle,
  onSheet,
}: {
  title: string;
  files: { label: string; url: string }[];
  clip: string | null;
  /** S/E/N when the folder name declares one — the tray checks rows against it. */
  facing?: string;
  onInit: (url: string) => void;
  onStyle: (url: string) => void;
  onSheet: (urls: string[], clip: string, facing?: string) => void;
}) {
  const [clip, setClip] = useState(declared ?? "");
  const sheetProps = clip
    ? {}
    : { disabled: true, title: "pick which clip these frames are — the tray files them under it" };
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <span style={S.note}>{title}</span>
        <select
          style={{ ...S.input, width: 110, fontSize: 11, padding: "1px 3px", ...(clip ? {} : { borderColor: AMBER.fg, color: AMBER.fg }) }}
          value={clip}
          onChange={(e) => setClip(e.target.value)}
        >
          {!clip && <option value="">— pick a clip —</option>}
          {CLIP_NAMES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        {files.length > 1 && (
          <button
            style={{ ...S.btn, fontSize: 10, padding: "0 6px", ...(clip ? {} : { opacity: 0.45, cursor: "not-allowed" }) }}
            {...sheetProps}
            onClick={() => onSheet(files.map((f) => f.url), clip, facing)}
          >
            + all {files.length}
          </button>
        )}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
        {files.map((a) => (
          <AssetThumb
            key={a.url}
            {...a}
            onInit={onInit}
            onStyle={onStyle}
            onSheet={(url) => onSheet([url], clip, facing)}
            sheetProps={sheetProps}
          />
        ))}
      </div>
    </div>
  );
}

export function LibraryCard({
  library,
  activeCharacter,
  onSelectProject,
  onSelectCharacter,
  onInit,
  onStyle,
  onSheet,
}: {
  library: LibraryState;
  activeCharacter: string | null;
  onSelectProject: (id: string) => void;
  onSelectCharacter: (name: string | null) => void;
  onInit: (url: string) => void;
  onStyle: (url: string) => void;
  onSheet: (urls: string[], clip: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const sel: LibraryCharacter | null = library.characters.find((c) => c.name === activeCharacter) ?? null;
  const hasArt = (c: LibraryCharacter) =>
    c.published.length + c.inbox.length + c.sources.length + c.recent.length > 0;
  const roster = showAll ? library.characters : library.characters.filter((c) => hasArt(c) || c.kind === "player");

  return (
    <div style={S.card}>
      <h2 style={S.cardTitle}>
        library
        {library.projects.length > 0 && (
          <select
            style={{ ...S.input, width: "auto", marginLeft: 10, display: "inline-block" }}
            value={library.activeProject ?? ""}
            onChange={(e) => onSelectProject(e.target.value)}
          >
            {library.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
        )}
        {activeCharacter && (
          <span style={S.chip(AMBER.fg, AMBER.bg)}>generations file under {activeCharacter}</span>
        )}
      </h2>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {roster.map((c) => (
          <button
            key={c.name}
            style={{ ...S.btn, ...(c.name === activeCharacter ? S.btnGreen : hasArt(c) ? {} : S.btnGhost) }}
            title={c.blurb || c.name}
            onClick={() => onSelectCharacter(c.name === activeCharacter ? null : c.name)}
          >
            {c.thumb ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={thumbUrl(c.thumb)} alt="" style={{ width: 16, height: 16, objectFit: "cover", verticalAlign: "-3px", marginRight: 5, borderRadius: 2, background: "#fff" }} />
            ) : (
              <span style={{ marginRight: 5 }}>{c.icon}</span>
            )}
            {c.label}
          </button>
        ))}
        <button style={{ ...S.btn, ...S.btnGhost }} onClick={() => setShowAll(!showAll)}>
          {showAll ? "with art only" : "whole roster…"}
        </button>
      </div>
      {sel && (
        <div style={{ marginTop: 10, padding: "8px 10px", background: "#0d0f14", borderRadius: 4 }}>
          {sel.blurb && <p style={{ ...S.note, marginTop: 0 }}>{sel.blurb}</p>}
          {sel.published.length > 0 && (
            <Group title="published (what the game ships)">
              {sel.published.map((a) => (
                <AssetThumb key={a.url} {...a} onInit={onInit} onStyle={onStyle} />
              ))}
            </Group>
          )}
          {sel.inbox.length > 0 && (
            <Group title="inbox (staged for npm run sprites)">
              {sel.inbox.map((a) => (
                <AssetThumb key={a.url} {...a} onInit={onInit} onStyle={onStyle} />
              ))}
            </Group>
          )}
          {sel.sources.map((s) => (
            <FrameGroup
              key={`${s.drop}/${s.group ?? ""}`}
              title={`sources · ${s.drop}${s.group ? ` · ${s.group}` : " (tracked originals)"}`}
              files={s.files}
              clip={s.clip}
              facing={/clip[_-]([SNE])[_-]/i.exec(s.group ?? "")?.[1]?.toUpperCase()}
              onInit={onInit}
              onStyle={onStyle}
              onSheet={onSheet}
            />
          ))}
          {sel.recent.map((r) => (
            <FrameGroup
              key={r.jobId}
              title={`work · ${r.label} (${r.frames.length} frame${r.frames.length === 1 ? "" : "s"})`}
              files={r.frames}
              clip={null}
              onInit={onInit}
              onStyle={onStyle}
              onSheet={onSheet}
            />
          ))}
          {!hasArt(sel) && (
            <p style={S.note}>
              no art yet — pick any image as the init (or pixelize a reference) and the first generation starts this
              character&rsquo;s library.
            </p>
          )}
        </div>
      )}
      {!library.characters.length && <p style={S.note}>no project selected — nothing to list.</p>}
      <p style={{ ...S.note, marginTop: 8 }}>
        <span style={S.chip(BLUE.fg, BLUE.bg)}>→ init</span> start from this art ·{" "}
        <span style={S.chip(GREY.fg, GREY.bg)}>→ style</span> match its look ·{" "}
        <span style={S.chip(AMBER.fg, AMBER.bg)}>+ sheet</span> curate it into the sheet tab — pick the keepers per
        clip, drop the rest, then assemble and stage · keep a generation with the <b>keep</b> button on its job card to
        file it under sources permanently
      </p>
    </div>
  );
}
