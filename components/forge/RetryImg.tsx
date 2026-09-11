"use client";

/**
 * An <img> that heals itself. A dev-server hot reload mid-render drops a
 * few of the 21 parallel frame requests, and a plain img that failed stays
 * a broken glyph forever — the "bunch of broken images" report. This one
 * retries with backoff (2s, 4s, 8s) and then stops; loading is lazy so an
 * off-screen strip does not stampede the server at all.
 */
import React, { useEffect, useRef, useState } from "react";

export function RetryImg({ src, alt, style, title }: { src: string; alt: string; style?: React.CSSProperties; title?: string }) {
  const [attempt, setAttempt] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const sep = src.includes("?") ? "&" : "?";
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={attempt ? `${src}${sep}retry=${attempt}` : src}
      alt={alt}
      title={title}
      loading="lazy"
      style={style}
      onError={() => {
        if (attempt >= 3) return;
        timer.current = setTimeout(() => setAttempt(attempt + 1), 2000 * 2 ** attempt);
      }}
    />
  );
}
