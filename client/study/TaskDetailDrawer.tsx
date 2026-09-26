import type { WebTask } from "../../shared/types.ts";
import { withInlineLinks, stripStrayMarkdown, stripHtml, useSmClose, SmSurface, useLang, openTab } from "../ui.tsx";

// "context" (and sourceDetail) is plain text, but often several distinct chunks of information run together
// as one dense wall — split on the AI's own paragraph breaks (newlines) so it reads as short paragraphs
// instead of one block. The generation prompt asks for "- " bullets, but older/already-generated tasks (and
// occasional model slips) run them together with no real newline at all — for those, also split on a
// " - "/" – " bullet marker mid-string as a fallback, so a wall of text still breaks up instead of staying
// one dense paragraph forever until the task is regenerated.
function Paragraphs({ text }: { text: string }) {
  let parts = text.split(/\n{2,}/).flatMap((p) => p.split(/\n/)).map((p) => p.trim()).filter(Boolean);
  if (parts.length <= 1) parts = text.split(/\s+[-–]\s+(?=\S)/).map((p) => p.trim()).filter(Boolean);
  return <>{(parts.length ? parts : [text]).map((p, i) => <p key={i}>{p}</p>)}</>;
}

interface TaskDetailDrawerProps {
  task: WebTask;
  onClose: () => void;
  onToggleStep?: (index: number, done: boolean) => void;
  onToggleSubstep?: (index: number, subIndex: number, done: boolean) => void;
  onComplete?: () => void;
}

// Full task context — title, why, the source's own detail, links, and the complete step breakdown (not
// just the "currently working on" step the session header shows). Study Mode deliberately keeps only the
// current step in view most of the time (see SessionHeader) so the student isn't staring at the whole
// checklist while heads-down — this is the "zoom out and see everything" escape hatch when they need it.
// Steps/substeps are real checkboxes (not read-only text) and there's a "mark task complete" action, so a
// student can actually finish a task from inside the session instead of leaving Study Mode to do it.
export function TaskDetailDrawer({ task, onClose, onToggleStep, onToggleSubstep, onComplete }: TaskDetailDrawerProps) {
  const L = useLang();
  const steps = task.steps || [];
  const doneCount = steps.filter(s => s.done).length;
  const isHandled = task.status === "done" || task.status === "dismissed";

  const { closing, doClose } = useSmClose(onClose, 240);
  return (
    <SmSurface variant="drawer" closing={closing} className="sm-drawer sm-drawer-task">
      <div className="sm-drawer-header">
        <span>{L("TÂCHE", "TASK")}</span>
        <button className="sm-drawer-close" onClick={doClose}>×</button>
      </div>
      <div className="sm-drawer-body">
        <h3 className="sm-task-detail-title">{stripStrayMarkdown(task.title)}</h3>
        {task.why && <p className="sm-task-detail-why">{stripStrayMarkdown(task.why)}</p>}
        {task.sourceDetail && (
          <div className="sm-task-detail-section">
            <h4>{L("Consignes", "Instructions")}</h4>
            <Paragraphs text={stripStrayMarkdown(stripHtml(task.sourceDetail))} />
          </div>
        )}
        {task.context && (
          <div className="sm-task-detail-section">
            <h4>{L("Contexte", "Context")}</h4>
            <Paragraphs text={stripStrayMarkdown(task.context)} />
          </div>
        )}
        {task.links?.length ? (
          <div className="sm-task-detail-section">
            <h4>{L("Liens", "Links")}</h4>
            <ul className="sm-task-detail-links">
              {task.links.map((l, i) => (
                // A plain <a target="_blank"> opens a tab the extension's Study Mode site-block then
                // immediately redirects to blocked.html — the block rule allowlists tabs OPENED THROUGH
                // Otto (openTab, below) but has no way to distinguish a plain browser-native anchor click
                // from a student wandering off to some other site. Reported live as "sources and links are
                // not fully opening and loading in study mode." openTab() posts through the extension when
                // present (which allowlists this exact host before opening, see background.js's
                // doOpenInGroup), falling back to a plain window.open when it's not.
                <li key={i}><a href={l.url} target="_blank" rel="noopener noreferrer" onClick={(e) => { e.preventDefault(); openTab(l.url, task.title); }}>{l.label}</a></li>
              ))}
            </ul>
          </div>
        ) : null}
        {steps.length > 0 && (
          <div className="sm-task-detail-section">
            <h4>{L(`Étapes (${doneCount}/${steps.length})`, `Steps (${doneCount}/${steps.length})`)}</h4>
            <ol className="sm-task-detail-steps">
              {steps.map((s, i) => (
                <li key={i} className={s.done ? "done" : ""}>
                  <button type="button" className="sm-task-detail-step-mark" aria-label={s.done ? L("Marquer l'étape comme non faite", "Mark step not done") : L("Marquer l'étape comme faite", "Mark step done")}
                    onClick={() => onToggleStep?.(i, !s.done)} disabled={!onToggleStep}>
                    {s.done ? "✓" : i + 1}
                  </button>
                  <span>{withInlineLinks(s.text)}</span>
                  {s.substeps?.length ? (
                    <ul className="sm-task-detail-substeps">
                      {s.substeps.map((sub, si) => (
                        <li key={si} className={sub.done ? "done" : ""}>
                          <label className="sm-task-detail-substep-label">
                            <input type="checkbox" checked={!!sub.done} disabled={!onToggleSubstep}
                              onChange={(e) => onToggleSubstep?.(i, si, e.target.checked)} />
                            {withInlineLinks(sub.text)}
                          </label>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ol>
          </div>
        )}
        {onComplete && !isHandled ? (
          <button type="button" className="sm-btn sm-btn-primary sm-task-detail-complete" onClick={onComplete}>
            {L("Marquer la tâche comme terminée", "Mark task complete")}
          </button>
        ) : null}
      </div>
    </SmSurface>
  );
}
