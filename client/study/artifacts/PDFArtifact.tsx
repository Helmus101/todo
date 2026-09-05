import { useEffect, useRef } from "react";
import type { ArtifactState } from "../StudyTypes.ts";

interface PDFArtifactProps {
  artifact: ArtifactState;
  onChange: (contentState: Record<string, unknown>) => void;
}

// Chrome's built-in PDF viewer's own 100% zoom renders a Letter/A4 page at roughly this many CSS px wide —
// used as the reference width for "what zoom% makes the page fill this pane". Approximate on purpose (page
// sizes vary); good enough for "no giant margins / no page wider than the pane", not pixel-perfect fit.
const REFERENCE_PAGE_WIDTH = 800;
const AUTO_ZOOM_MIN = 60, AUTO_ZOOM_MAX = 180;

export function PDFArtifact({ artifact, onChange }: PDFArtifactProps) {
  const page = Number(artifact.contentState?.page || 1);
  const zoom = Number(artifact.contentState?.zoom || 100);
  // Undefined counts as true (auto-zoom is the default) — only an explicit manual zoom-slider touch turns
  // it off, so auto-fit doesn't fight a preference the student actually set.
  const autoZoom = artifact.contentState?.autoZoom !== false;
  const url = artifact.source;
  const src = url ? `${url}#page=${page}&zoom=${zoom}` : "";
  const containerRef = useRef<HTMLDivElement>(null);

  // Re-fit zoom to the pane's actual width whenever it resizes — the pane resizes a lot now (auto-tiling on
  // open/close, the coupled-neighbor resize), and a PDF stuck at a fixed zoom% would otherwise need a manual
  // re-zoom after every one of those instead of just staying readable. Debounced: a resize (especially mid-
  // drag) fires continuously, and reloading the PDF viewer's iframe on every pixel would be both janky and
  // wasteful — only the settled final size actually applies.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !autoZoom) return;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (!w) return;
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        const fit = Math.round(Math.max(AUTO_ZOOM_MIN, Math.min(AUTO_ZOOM_MAX, (w / REFERENCE_PAGE_WIDTH) * 100)));
        // A few percent of slack — otherwise a sub-pixel layout jitter would reload the iframe forever.
        if (Math.abs(fit - zoom) >= 5) onChange({ ...artifact.contentState, zoom: fit });
      }, 250);
    });
    ro.observe(el);
    return () => { clearTimeout(debounce); ro.disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoZoom]);

  return (
    <div className="sm-pdf-body" ref={containerRef}>
      <div className="sm-artifact-toolbar">
        <label>
          Page
          <input
            className="sm-toolbar-number"
            type="number"
            min={1}
            value={page}
            onChange={(e) => onChange({ ...artifact.contentState, page: Math.max(1, Number(e.target.value) || 1) })}
          />
        </label>
        <label>
          Zoom
          <input
            className="sm-toolbar-range"
            type="range"
            min={AUTO_ZOOM_MIN}
            max={AUTO_ZOOM_MAX}
            step={10}
            value={zoom}
            // Any manual drag of the slider is the student overriding auto-fit on purpose — stop re-fitting
            // this pane until it's resized again well past this size (autoZoom flips back on naturally only
            // via a fresh artifact; simplest, least-surprising rule: manual once, manual for the session).
            onChange={(e) => onChange({ ...artifact.contentState, zoom: Number(e.target.value), autoZoom: false })}
          />
        </label>
        <span className="sm-toolbar-value">{zoom}%</span>
      </div>
      {url ? (
        <>
          {/* NO sandbox here — Chrome's own built-in PDF viewer refuses to render at all inside a sandboxed
              iframe ("This page has been blocked by Chrome"), unlike a real embedded web app. A static PDF
              (blob: for an upload, or an external link) doesn't run arbitrary navigating scripts the way
              Padlet/Desmos/Spotify's iframes do, so the top-navigation risk sandboxing guards against there
              doesn't really apply here the same way. */}
          <iframe className="sm-embed" src={src} title={artifact.title} />
          {/* Our own CSP allows this (server/index.ts's frame-src), but a THIRD-PARTY PDF host can still
              refuse to be framed via its own X-Frame-Options/CSP — invisible to JS (no onError fires), so
              the student would otherwise be stuck looking at a blank/blocked pane with no way out. */}
          <a className="sm-pdf-fallback-link" href={url} target="_blank" rel="noopener noreferrer">
            Not loading? Open in a new tab ↗
          </a>
        </>
      ) : (
        <div className="sm-artifact-empty">No PDF attached.</div>
      )}
    </div>
  );
}
