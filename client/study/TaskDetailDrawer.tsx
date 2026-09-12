import type { WebTask } from "../../shared/types.ts";
import { withInlineLinks, stripStrayMarkdown, stripHtml } from "../ui.tsx";

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
  const steps = task.steps || [];
  const doneCount = steps.filter(s => s.done).length;
  const isHandled = task.status === "done" || task.status === "dismissed";

  return (
    <div className="sm-drawer sm-drawer-task">
      <div className="sm-drawer-header">
        <span>TASK</span>
        <button className="sm-drawer-close" onClick={onClose}>×</button>
      </div>
      <div className="sm-drawer-body">
        <h3 className="sm-task-detail-title">{stripStrayMarkdown(task.title)}</h3>
        {task.why && <p className="sm-task-detail-why">{stripStrayMarkdown(task.why)}</p>}
        {task.sourceDetail && (
          <div className="sm-task-detail-section">
            <h4>Instructions</h4>
            <p>{stripStrayMarkdown(stripHtml(task.sourceDetail))}</p>
          </div>
        )}
        {task.context && (
          <div className="sm-task-detail-section">
            <h4>Context</h4>
            <p>{stripStrayMarkdown(task.context)}</p>
          </div>
        )}
        {task.links?.length ? (
          <div className="sm-task-detail-section">
            <h4>Links</h4>
            <ul className="sm-task-detail-links">
              {task.links.map((l, i) => <li key={i}><a href={l.url} target="_blank" rel="noopener noreferrer">{l.label}</a></li>)}
            </ul>
          </div>
        ) : null}
        {steps.length > 0 && (
          <div className="sm-task-detail-section">
            <h4>Steps ({doneCount}/{steps.length})</h4>
            <ol className="sm-task-detail-steps">
              {steps.map((s, i) => (
                <li key={i} className={s.done ? "done" : ""}>
                  <button type="button" className="sm-task-detail-step-mark" aria-label={s.done ? "Mark step not done" : "Mark step done"}
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
            Mark task complete
          </button>
        ) : null}
      </div>
    </div>
  );
}
