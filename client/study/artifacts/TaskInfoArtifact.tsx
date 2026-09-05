import type { WebTask } from "../../../shared/types.ts";
import { withInlineLinks, stripStrayMarkdown, stripHtml } from "../../ui.tsx";

interface TaskInfoArtifactProps {
  task: WebTask;
}

// Same content as TaskDetailDrawer.tsx (title/why/instructions/context/links/steps) but as a draggable,
// resizable desk artifact instead of a fixed sidebar — so a student can keep the task's own instructions
// and checklist visible ALONGSIDE their notes/PDF/etc rather than having to pop the drawer open and closed.
export function TaskInfoArtifact({ task }: TaskInfoArtifactProps) {
  const steps = task.steps || [];
  const doneCount = steps.filter(s => s.done).length;

  return (
    <div className="sm-task-artifact-body">
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
                <span className="sm-task-detail-step-mark" aria-hidden="true">{s.done ? "✓" : i + 1}</span>
                <span>{withInlineLinks(s.text)}</span>
                {s.substeps?.length ? (
                  <ul className="sm-task-detail-substeps">
                    {s.substeps.map((sub, si) => (
                      <li key={si} className={sub.done ? "done" : ""}>{withInlineLinks(sub.text)}</li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
