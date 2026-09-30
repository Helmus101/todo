import { useState } from "react";
import { DESMOS_TOOLS, desmosToolUrl, type DesmosToolId } from "./desmosTools.ts";
import { useLang } from "../ui.tsx";

/** Tutor Session's Desmos place — the one spot where the student can actually USE Desmos tools during a
 *  lesson (reported: "make sure in the tutor you have a place for desmos extensions that user can use").
 *  Rendered at the top of the BOARD pane, above the board body: the board is where the lesson's visuals
 *  live, and Desmos is the visual tool that pairs with it (plot the function Otto just wrote on the
 *  board, measure the triangle in the diagram). Collapsed by default so the tool is discoverable but the
 *  board stays the star; the student's click opens it, like every other manual surface in the tutor.
 *
 *  Embedding mirrors Study Mode's DesmosArtifact exactly — same four URLs, same iframe contract
 *  (`allow="fullscreen"`, sandbox without allow-top-navigation, per-tool remount via key). The pure
 *  URL/id contract lives in desmosTools.ts so tests can pin it without a renderer. */
export function TutorDesmos() {
  const L = useLang();
  const [open, setOpen] = useState(false);
  const [toolId, setToolId] = useState<DesmosToolId>("graphing");
  const tool = DESMOS_TOOLS.find((t) => t.id === toolId) || DESMOS_TOOLS[0];

  return (
    <div className="tutor-desmos">
      <button type="button" className="tutor-desmos-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="tutor-desmos-glyph" aria-hidden>ƒ</span>
        <span>{L("Outils Desmos", "Desmos tools")}</span>
        <span className="tutor-desmos-chev" aria-hidden>{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="tutor-desmos-panel">
          <div className="tutor-desmos-tabs" role="tablist" aria-label={L("Outils Desmos", "Desmos tools")}>
            {DESMOS_TOOLS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={t.id === toolId}
                className={`tutor-desmos-tab${t.id === toolId ? " on" : ""}`}
                onClick={() => setToolId(t.id)}
              >
                {L(t.label[0], t.label[1])}
              </button>
            ))}
            {/* Link-out for small screens / fullscreen preference — opens the SAME tool in its own tab. */}
            <a className="tutor-desmos-pop" href={tool.path} target="_blank" rel="noreferrer noopener">
              {L("Ouvrir dans un onglet", "Open in a tab")} ↗
            </a>
          </div>
          <div className="tutor-desmos-frame-wrap">
            {/* key={toolId}: switching tools remounts the iframe — each calculator starts clean instead of
                inheriting the previous tool's expressions. */}
            <iframe
              key={toolId}
              src={desmosToolUrl(toolId)}
              title={`Desmos ${L(tool.label[0], tool.label[1])}`}
              className="tutor-desmos-frame"
              allow="fullscreen"
              // No allow-top-navigation — Desmos (or anything it links out to) must never redirect the outer tab.
              sandbox="allow-scripts allow-same-origin allow-popups"
            />
            <p className="tutor-desmos-hint">{L(tool.hint[0], tool.hint[1])}</p>
          </div>
        </div>
      )}
    </div>
  );
}
