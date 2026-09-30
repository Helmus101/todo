import { DESMOS_TOOLS, desmosToolUrl } from "./desmosTools.ts";
import { useLang } from "../ui.tsx";

/** Tutor Session's Desmos place — the one spot where the student can actually USE Desmos during a lesson
 *  (reported: "make sure in the tutor you have a place for desmos extensions that user can use"). Renders
 *  as a FULL REPLACEMENT of the board pane's content while open (reported live: opening Desmos used to
 *  squeeze a small iframe in above the board instead of taking over — now the parent, TutorSession, swaps
 *  this in for <BoardArtifact> entirely via its own `desmosOpen` state; closing it restores the board
 *  exactly as it was, since the board's own state was never touched). ONE calculator only — see
 *  desmosTools.ts's own comment on why the four-tool picker was dropped.
 *
 *  Embedding mirrors Study Mode's DesmosArtifact exactly — same embed URL, same iframe contract
 *  (`allow="fullscreen"`, sandbox without allow-top-navigation). The pure URL/id contract lives in
 *  desmosTools.ts so tests can pin it without a renderer. */
export function TutorDesmos({ onClose }: { onClose: () => void }) {
  const L = useLang();
  const tool = DESMOS_TOOLS[0];

  return (
    <div className="tutor-desmos-full">
      <div className="tutor-desmos-full-header">
        <span className="tutor-desmos-glyph" aria-hidden>ƒ</span>
        <span>{L(tool.label[0], tool.label[1])}</span>
        {/* Link-out for small screens / fullscreen preference — opens the SAME tool in its own tab. */}
        <a className="tutor-desmos-pop" href={tool.path} target="_blank" rel="noreferrer noopener">
          {L("Ouvrir dans un onglet", "Open in a tab")} ↗
        </a>
        <button type="button" className="btn ghost xs tutor-desmos-close" onClick={onClose}>
          {L("Retour au tableau", "Back to board")}
        </button>
      </div>
      <div className="tutor-desmos-full-frame-wrap">
        <iframe
          src={desmosToolUrl(tool.id)}
          title={`Desmos ${L(tool.label[0], tool.label[1])}`}
          className="tutor-desmos-frame"
          allow="fullscreen"
          // No allow-top-navigation — Desmos (or anything it links out to) must never redirect the outer tab.
          sandbox="allow-scripts allow-same-origin allow-popups"
        />
      </div>
      <p className="tutor-desmos-hint">{L(tool.hint[0], tool.hint[1])}</p>
    </div>
  );
}
