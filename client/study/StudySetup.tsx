import { useEffect, useMemo, useRef, useState } from "react";
import type { WebTask } from "../../shared/types.ts";
import type { StudyEnvironment, StudyMaterial } from "./StudyTypes.ts";
import { extractPdfText } from "./pdfText.ts";
import { api } from "../api.ts";
import { stripHtml } from "../ui.tsx";

export interface PomodoroChoice { enabled: boolean; workMinutes: number; breakMinutes: number; armId: string }
export interface AudioChoice { audioType: "silence" | "brown" | "pink" | "white"; armId?: string }

interface StudySetupProps {
  task: WebTask;
  existingEnv: StudyEnvironment | null;
  onStart: (materials: StudyMaterial[], pomodoro: PomodoroChoice, audio: AudioChoice) => void;
  onResume?: () => void;
  onExit: () => void;
}

const YOUTUBE_RE = /(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/;

function getYouTubeId(url: string): string | null {
  const m = url.match(YOUTUBE_RE);
  return m ? m[1] : null;
}

export function classifyUrl(url: string): "video" | "document" | "pdf" | "link" {
  if (getYouTubeId(url)) return "video";
  if (url.match(/\.pdf($|\?)/i)) return "pdf";
  // Padlet boards embed the same way Google Docs do (DocumentArtifact.tsx handles both) — without this a
  // Padlet link fell through to plain "link" and never reached the iframe embed at all.
  if (url.match(/docs\.google\.com|:\/\/([a-z0-9-]+\.)?padlet\.(com|org)\//i)) return "document";
  return "link";
}

function hostnameOrFallback(url: string, fallback: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return fallback;
  }
}

function buildTaskMaterials(task: WebTask): StudyMaterial[] {
  const seen = new Set<string>();
  const add = (items: StudyMaterial[], material: StudyMaterial) => {
    const key = material.url || material.objectUrl || material.label;
    if (seen.has(key)) return;
    seen.add(key);
    items.push(material);
  };

  const materials: StudyMaterial[] = [];
  task.evidence?.forEach((item, idx) => {
    add(materials, {
      id: `evidence-${idx}`,
      label: item.label || "Source material",
      type: item.url ? classifyUrl(item.url) : "document",
      url: item.url,
      source: task.source || "source",
    });
  });

  task.links?.forEach((item, idx) => {
    const type = item.url ? classifyUrl(item.url) : "link";
    add(materials, {
      id: `link-${idx}`,
      label: item.label || (item.url ? hostnameOrFallback(item.url, "Task link") : "Task link"),
      type,
      url: type === "video" ? `https://www.youtube-nocookie.com/embed/${getYouTubeId(item.url)}` : item.url,
      source: "task",
    });
  });

  task.artifacts?.forEach((item, idx) => {
    add(materials, {
      id: `artifact-${idx}`,
      label: item.label || item.kind,
      type: item.url ? classifyUrl(item.url) : "document",
      url: item.url,
      source: "otto",
    });
  });

  if (task.sourceDetail) {
    add(materials, {
      id: "source-detail",
      label: "Task instructions",
      type: "note",
      source: task.source || "task",
      text: stripHtml(task.sourceDetail),
    });
  }

  // Otto's own generated study artifacts (briefs/decks/quizzes made during the run — see runTask's
  // CREATE_NOTE/CREATE_FLASHCARDS/CREATE_QUIZ tools in server/claude.ts) belong on the desk alongside the
  // task's source materials — a student shouldn't have to leave Study Mode to find work Otto already did.
  task.notes?.forEach((n) => {
    add(materials, { id: `note-${n.id}`, label: n.title, type: "note", source: "otto", text: n.body });
  });
  task.flashcards?.forEach((f) => {
    add(materials, { id: `flashcards-${f.id}`, label: f.title, type: "flashcard", source: "otto", text: f.id });
  });
  task.quizzes?.forEach((q) => {
    add(materials, { id: `quiz-${q.id}`, label: q.title, type: "quiz", source: "otto", text: q.id });
  });

  return materials;
}

export function StudySetup({ task, existingEnv, onStart, onResume, onExit }: StudySetupProps) {
  const initialMaterials = useMemo(() => existingEnv?.materials || buildTaskMaterials(task), [existingEnv, task]);
  const [materials, setMaterials] = useState<StudyMaterial[]>(initialMaterials);
  const [linkInput, setLinkInput] = useState("");
  const [linkLabel, setLinkLabel] = useState("");
  const [linkError, setLinkError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pomodoroEnabled, setPomodoroEnabled] = useState(existingEnv?.pomodoroEnabled ?? false);
  const [workMinutes, setWorkMinutes] = useState(existingEnv?.pomodoroWorkMinutes ?? 25);
  const [breakMinutes, setBreakMinutes] = useState(existingEnv?.pomodoroBreakMinutes ?? 5);
  const [audioChoice, setAudioChoice] = useState<AudioChoice>({ audioType: "silence" });
  const suggestionRef = useRef<{ enabled: boolean; workMinutes: number; breakMinutes: number } | null>(null);
  useEffect(() => {
    // Only for a genuinely FRESH session — resuming an existing environment means the student already
    // made (and is relying on) their own choice; the bandit must never override that.
    if (existingEnv) return;
    void api.pomodoroSuggestion().then((s) => {
      setPomodoroEnabled(s.enabled);
      setWorkMinutes(s.workMinutes);
      setBreakMinutes(s.breakMinutes);
      suggestionRef.current = { enabled: s.enabled, workMinutes: s.workMinutes, breakMinutes: s.breakMinutes };
    }).catch(() => {}); // best-effort — the picker's own hardcoded defaults (25/5, off) already cover this
    void api.audioSuggestion().then((s) => {
      setAudioChoice({ audioType: s.audioType, armId: s.audioType });
    }).catch(() => {}); // best-effort — the desk's own hardcoded default (silence) already covers this
  }, [existingEnv]);
  // Whatever arm this session ACTUALLY runs under, whether that's the suggestion left untouched or
  // something the student changed by hand — matches server/bandit.ts's POMODORO_ARMS id scheme when it
  // lands on one of the fixed options; a genuinely custom value just won't match a known arm server-side
  // and that outcome report is quietly ignored later (expected, not an error — the bandit only tracks the
  // fixed menu it actually offers).
  const armId = pomodoroEnabled ? `${workMinutes}/${breakMinutes}` : "none";

  const steps = task.steps || [];
  const currentStep = steps.find(s => !s.done);

  const addLink = () => {
    setLinkError("");
    const url = linkInput.trim();
    if (!url) return;
    try {
      new URL(url.startsWith("http") ? url : `https://${url}`);
    } catch {
      setLinkError("Enter a valid URL.");
      return;
    }
    const fullUrl = url.startsWith("http") ? url : `https://${url}`;
    const type = classifyUrl(fullUrl);
    const label = linkLabel.trim() || (type === "video" ? "Video" : new URL(fullUrl).hostname);
    const mat: StudyMaterial = {
      id: crypto.randomUUID(),
      label,
      type,
      url: type === "video" ? `https://www.youtube-nocookie.com/embed/${getYouTubeId(fullUrl)}` : fullUrl,
      source: type === "video" ? "youtube" : "link",
    };
    setMaterials(prev => [...prev, mat]);
    setLinkInput("");
    setLinkLabel("");
    void api.recordMetric("study_material_added", 1, type);
  };

  const handleFiles = (files: FileList | null) => {
    if (!files) return;
    Array.from(files).forEach(file => {
      const objectUrl = URL.createObjectURL(file);
      const type: StudyMaterial["type"] = file.type === "application/pdf" ? "pdf" :
        file.type.startsWith("image/") ? "image" : "document";
      const mat: StudyMaterial = {
        id: crypto.randomUUID(),
        label: file.name,
        type,
        objectUrl,
        source: "upload",
        size: file.size,
      };
      setMaterials(prev => [...prev, mat]);
      void api.recordMetric("study_material_added", 1, type);
      if (type === "pdf") void api.recordMetric("study_pdf_uploaded", 1);
      // Best-effort, async, non-blocking: the material is already usable (viewable in PDFArtifact) the
      // instant it's added above — this just fills in `text` a moment later so the chat can reference the
      // PDF's actual content (see pdfText.ts). A scanned/image-only PDF or extraction failure just leaves
      // `text` unset, same as before this existed.
      if (type === "pdf") {
        void extractPdfText(file).then((text) => {
          if (!text) return;
          setMaterials(prev => prev.map(m => m.id === mat.id ? { ...m, text } : m));
        });
      }
    });
  };

  const removeMaterial = (id: string) => {
    setMaterials(prev => {
      const mat = prev.find(m => m.id === id);
      if (mat?.objectUrl) URL.revokeObjectURL(mat.objectUrl);
      return prev.filter(m => m.id !== id);
    });
  };

  const typeIcon = (type: StudyMaterial["type"]) => {
    if (type === "pdf") return "PDF";
    if (type === "video") return "▶";
    if (type === "image") return "▨";
    if (type === "document") return "▤";
    if (type === "note") return "▤";
    if (type === "flashcard") return "❏";
    if (type === "quiz") return "?";
    return "Link";
  };

  return (
    <div className="sm-setup">
      <div className="sm-setup-inner">
        {/* Header */}
        <button className="sm-setup-back" onClick={onExit}>← Back</button>

        <div className="sm-setup-task">
          <p className="sm-setup-label">STUDY MODE</p>
          <h1 className="sm-setup-title">{task.title}</h1>
          {currentStep && <p className="sm-setup-step">Starting with: <strong>{currentStep.text}</strong></p>}
          {steps.length > 0 && (
            <p className="sm-setup-meta">{steps.length} steps · {steps.filter(s => s.done).length} completed</p>
          )}
        </div>

        {/* Resume banner */}
        {existingEnv && onResume && (
          <div className="sm-setup-resume">
            <div>
              <strong>Resume previous session</strong>
              <p>Your desk has been saved — resume exactly where you left off.</p>
            </div>
            <button className="sm-btn sm-btn-primary" onClick={onResume}>Resume</button>
          </div>
        )}

        {/* Materials */}
        <div className="sm-setup-section">
          <h2>Materials for this session</h2>
          <p className="sm-setup-hint">Add everything you'll need before starting. Study Mode keeps this task's materials contained on your desk.</p>

          {/* Link / URL input */}
          <div className="sm-setup-link-row">
            <input
              className="sm-setup-input"
              type="text"
              placeholder="Paste a link — YouTube, PDF, Google Doc, anything…"
              value={linkInput}
              onChange={e => { setLinkInput(e.target.value); setLinkError(""); }}
              onKeyDown={e => e.key === "Enter" && addLink()}
            />
            <input
              className="sm-setup-input sm-setup-input-sm"
              type="text"
              placeholder="Label (optional)"
              value={linkLabel}
              onChange={e => setLinkLabel(e.target.value)}
            />
            <button className="sm-btn sm-btn-ghost" onClick={addLink}>Add</button>
          </div>
          {linkError && <p className="sm-setup-error">{linkError}</p>}

          {/* File upload */}
          <div
            className="sm-setup-dropzone"
            onClick={() => fileInputRef.current?.click()}
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); handleFiles(e.dataTransfer.files); }}
          >
            <span>Upload files — PDF, images, documents</span>
            <span className="sm-setup-dropzone-hint">Click or drag & drop</span>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".pdf,.doc,.docx,.ppt,.pptx,.txt,.png,.jpg,.jpeg,.gif,.webp"
            style={{ display: "none" }}
            onChange={e => handleFiles(e.target.files)}
          />

          {/* Material list */}
          {materials.length > 0 && (
            <ul className="sm-setup-materials">
              {materials.map(m => (
                <li key={m.id} className="sm-setup-material-item">
                  <span className="sm-mat-icon">{typeIcon(m.type)}</span>
                  <span className="sm-mat-label">{m.label}</span>
                  {m.size && <span className="sm-mat-size">{(m.size / 1024).toFixed(0)} KB</span>}
                  <button className="sm-mat-remove" onClick={() => removeMaterial(m.id)}>×</button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Pomodoro */}
        <div className="sm-setup-section">
          <label className="sm-setup-toggle-row">
            <input type="checkbox" checked={pomodoroEnabled} onChange={(e) => setPomodoroEnabled(e.target.checked)} />
            <span>Use Pomodoro — auto-alternate work and break</span>
          </label>
          {pomodoroEnabled && (
            <div className="sm-pomodoro-config">
              <label>
                Work
                <input type="number" min={5} max={90} value={workMinutes} onChange={(e) => setWorkMinutes(Math.max(5, Math.min(90, Number(e.target.value) || 25)))} /> min
              </label>
              <label>
                Break
                <input type="number" min={1} max={30} value={breakMinutes} onChange={(e) => setBreakMinutes(Math.max(1, Math.min(30, Number(e.target.value) || 5)))} /> min
              </label>
            </div>
          )}
        </div>

        {/* Start button */}
        <div className="sm-setup-footer">
          <button className="sm-btn sm-btn-primary sm-btn-lg" onClick={() => {
            const sugg = suggestionRef.current;
            if (sugg && (sugg.enabled !== pomodoroEnabled || sugg.workMinutes !== workMinutes || sugg.breakMinutes !== breakMinutes)) {
              void api.recordMetric("pomodoro_manually_overridden", 1);
            }
            onStart(materials, { enabled: pomodoroEnabled, workMinutes, breakMinutes, armId }, audioChoice);
          }}>
            {existingEnv ? "Start new session" : "Start studying"}
          </button>
          <p className="sm-setup-footer-hint">
            {materials.length === 0 ? "You can start without materials — add them later from the Materials panel." : `${materials.length} material${materials.length > 1 ? "s" : ""} ready`}
          </p>
        </div>
      </div>
    </div>
  );
}
