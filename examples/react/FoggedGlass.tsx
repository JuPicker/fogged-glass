"use client";

/**
 * Fogged Glass as a React component.
 *
 * Copy fogged-glass.js and fogged-glass.d.ts next to this file (or adjust the import).
 * The element is registered in the browser only, so this works in Next.js as is:
 *
 *   <FoggedGlass src="/view.mp4" poster="/view.jpg" target="0.6,0.7,0.1,0.1"
 *     onReveal={(glass) => glass.clearAll(1.8)} style={{ position: "fixed", inset: 0 }} />
 *
 * Every other data-* attribute of the README goes through `options` (camelCase keys).
 */
import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import type { FoggedGlassElement, FogProgress, WritingResult } from "./fogged-glass";

type Props = {
  src: string;
  poster?: string;
  /** Media-space rect "x,y,w,h" (0 to 1, y down) of the thing to find. */
  target?: string;
  /** "write": write a word to unlock. */
  goal?: "write";
  /** Any other attribute: { refog: 16, brush: 26, focus: "0.6,0.5" } */
  options?: Record<string, string | number>;
  className?: string;
  style?: CSSProperties;
  onReveal?: (glass: FoggedGlassElement, detail: FogProgress | WritingResult) => void;
  onProgress?: (detail: FogProgress) => void;
  onWrite?: (detail: WritingResult) => void;
};

export function FoggedGlass({ src, poster, target, goal, options = {}, className, style, onReveal, onProgress, onWrite }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const glass = useRef<FoggedGlassElement | null>(null);
  const handlers = useRef({ onReveal, onProgress, onWrite });
  useEffect(() => {
    handlers.current = { onReveal, onProgress, onWrite };
  });

  // one element for the component's life, created in the browser
  useEffect(() => {
    let dead = false;
    import("./fogged-glass").then(() => {
      if (dead || !host.current) return;
      const el = document.createElement("fogged-glass");
      el.style.cssText = "position:absolute;inset:0";
      el.addEventListener("fogreveal", (e) => handlers.current.onReveal?.(el, e.detail));
      el.addEventListener("fogprogress", (e) => handlers.current.onProgress?.(e.detail));
      el.addEventListener("fogwrite", (e) => handlers.current.onWrite?.(e.detail));
      glass.current = el;
      apply(el, { src, poster, target, goal, ...options });
      host.current.appendChild(el);
    });
    return () => {
      dead = true;
      glass.current?.remove();   // the element frees its GL context when it leaves the page
      glass.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // later changes are plain attribute writes: the engine reads them every frame
  const key = JSON.stringify({ src, poster, target, goal, options });
  useEffect(() => {
    if (glass.current) apply(glass.current, { src, poster, target, goal, ...options });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return <div ref={host} className={className} style={{ position: "relative", ...style }} />;
}

function apply(el: FoggedGlassElement, values: Record<string, string | number | undefined>) {
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined || v === "") delete el.dataset[k];
    else el.dataset[k] = String(v);
  }
}
