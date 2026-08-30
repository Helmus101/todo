import { useState, useEffect, useCallback, useRef } from "react";
import type { WebTask } from "../../shared/types.ts";
import type {
  StudyEnvironment,
  StudyMaterial,
  WorkspaceTemplate,
  SessionLog,
  ArtifactState,
  SessionStatus,
} from "./StudyTypes.ts";
import { getEnvironmentByTask, saveEnvironment, saveSession } from "./StudyDB.ts";
import { StudySetup } from "./StudySetup.tsx";
import { SessionHeader } from "./SessionHeader.tsx";
import { ArtifactCanvas } from "./ArtifactCanvas.tsx";
import { BottomBar } from "./BottomBar.tsx";
import { MaterialsDrawer } from "./MaterialsDrawer.tsx";
import { ToolsDrawer } from "./ToolsDrawer.tsx";
import { AudioPanel } from "./AudioPanel.tsx";
import { AskOttoPanel } from "./AskOttoPanel.tsx";
import { BreakScreen } from "./BreakScreen.tsx";
import { EndSessionModal } from "./EndSessionModal.tsx";
import { SubtaskSubmit } from "./SubtaskSubmit.tsx";
import { api } from "../api.ts";

interface StudyModeProps {
  task: WebTask;
  onExit: () => void;
  userId?: string;
}

// ── Detect task type from task title/description ──────────────────────────────
function detectTemplate(task: WebTask): WorkspaceTemplate {
  const text = `${task.title} ${task.why || ""} ${task.context || ""}`.toLowerCase();
  if (/essay|write|rédiger|rédaction|écrire|writing/.test(text)) return "WRITING";
  if (/read|lecture|chapter|textbook|pdf|article|lire/.test(text)) return "READING";
  if (/exercice|problem|math|physics|calcul|solve|équation|equation/.test(text)) return "PROBLEM_SOLVING";
  if (/revise|revision|révision|flashcard|recall|mémoriser|learn/.test(text)) return "REVISION";
  if (/research|recherche|study|source|investigate/.test(text)) return "RESEARCH";
  if (/project|projet|presentation|présentation/.test(text)) return "PROJECT";
  return "STANDARD";
}

// ── Build initial artifact layout from template ───────────────────────────────
function buildInitialArtifacts(template: WorkspaceTemplate, envId: string, taskId: string, materials: StudyMaterial[]): ArtifactState[] {
  const base = { environmentId: envId, taskId, zIndex: 1, minimized: false, maximized: false, dockSide: "none" as const, contentState: {} };

  // Find first real material
  const firstPDF = materials.find(m => m.type === "pdf");
  const firstVideo = materials.find(m => m.type === "video");
  const firstDoc = materials.find(m => m.type === "document");

  switch (template) {
    case "WRITING":
      return [
        {
          ...base,
          id: `${envId}-doc`,
          type: "document",
          title: firstDoc?.label || "Document",
          x: 60, y: 10,
          width: 65, height: 80,
          source: firstDoc?.url,
          sourceLabel: firstDoc?.label,
        },
        {
          ...base,
          id: `${envId}-notes`,
          type: "notes",
          title: "Notes",
          x: 0, y: 10,
          width: 25, height: 80,
          dockSide: "left",
          zIndex: 2,
        },
      ];

    case "READING":
      return [
        {
          ...base,
          id: `${envId}-pdf`,
          type: "pdf",
          title: firstPDF?.label || "Reading",
          x: 10, y: 5,
          width: 80, height: 88,
          source: firstPDF?.objectUrl || firstPDF?.url,
          sourceLabel: firstPDF?.label,
          maximized: !firstVideo,
        },
        {
          ...base,
          id: `${envId}-notes`,
          type: "notes",
          title: "Notes",
          x: 70, y: 5,
          width: 28, height: 88,
          dockSide: "right",
          zIndex: 2,
        },
      ];

    case "PROBLEM_SOLVING":
      return [
        {
          ...base,
          id: `${envId}-pdf`,
          type: "pdf",
          title: firstPDF?.label || "Problem Set",
          x: 2, y: 5,
          width: 57, height: 85,
          source: firstPDF?.objectUrl || firstPDF?.url,
        },
        {
          ...base,
          id: `${envId}-scratch`,
          type: "scratchpad",
          title: "Scratchpad",
          x: 61, y: 5,
          width: 36, height: 85,
          dockSide: "right",
          zIndex: 2,
        },
      ];

    case "REVISION":
      return [
        {
          ...base,
          id: `${envId}-flash`,
          type: "flashcard",
          title: "Flashcards",
          x: 20, y: 10,
          width: 60, height: 75,
        },
      ];

    case "RESEARCH":
      return [
        {
          ...base,
          id: `${envId}-pdf`,
          type: "pdf",
          title: firstPDF?.label || "Source",
          x: 2, y: 5,
          width: 60, height: 85,
          source: firstPDF?.objectUrl || firstPDF?.url,
        },
        {
          ...base,
          id: `${envId}-notes`,
          type: "notes",
          title: "Notes",
          x: 64, y: 5,
          width: 34, height: 85,
          dockSide: "right",
          zIndex: 2,
        },
      ];

    default: // STANDARD, PROJECT
      return [
        {
          ...base,
          id: `${envId}-notes`,
          type: "notes",
          title: "Notes",
          x: 20, y: 10,
          width: 60, height: 75,
        },
      ];
  }
}

// ── Audio URLs ────────────────────────────────────────────────────────────────
export const AUDIO_OPTIONS: { id: string; label: string; url: string }[] = [
  { id: "brown", label: "Brown noise", url: "https://cdn.pixabay.com/audio/2022/01/18/audio_d0a13f69d2.mp3" },
  { id: "rain", label: "Rain", url: "https://cdn.pixabay.com/audio/2021/08/09/audio_0124f52e0c.mp3" },
  { id: "cafe", label: "Café", url: "https://cdn.pixabay.com/audio/2022/03/10/audio_c8c8a73467.mp3" },
  { id: "classical", label: "Classical", url: "https://cdn.pixabay.com/audio/2022/05/27/audio_1808fbf07a.mp3" },
  { id: "white", label: "White noise", url: "https://cdn.pixabay.com/audio/2022/01/18/audio_d0a13f69d2.mp3" },
];

// ── Main StudyMode component ───────────────────────────────────────────────────
export function StudyMode({ task, onExit, userId }: StudyModeProps) {
  const [phase, setPhase] = useState<"setup" | "session">("setup");
  const [env, setEnv] = useState<StudyEnvironment | null>(null);
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>("idle");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [breakSeconds, setBreakSeconds] = useState(0);
  const [openPanel, setOpenPanel] = useState<"materials" | "tools" | "audio" | "ai" | "notes" | "scratchpad" | null>(null);
  const [showEndModal, setShowEndModal] = useState(false);
  const [showSubtaskSubmit, setShowSubtaskSubmit] = useState(false);
  const [sessionLog, setSessionLog] = useState<SessionLog>({
    id: crypto.randomUUID(),
    taskId: task.id,
    environmentId: "",
    startedAt: new Date().toISOString(),
    elapsedSeconds: 0,
    breakSeconds: 0,
    completedSubtasks: [],
    submittedWork: [],
  });
  const [aiChat, setAiChat] = useState<{ role: "user" | "assistant"; text: string }[]>([]);
  const [saveIndicator, setSaveIndicator] = useState<"saved" | "saving" | "">("");

  const timerRef = useRef<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const saveDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const doneSteps = task.steps?.filter(s => s.done).length ?? 0;
  const totalSteps = task.steps?.length ?? 0;

  // ── Check if device is phone ──────────────────────────────────────────────
  const isPhone = typeof window !== "undefined" && window.innerWidth < 768;

  // ── Load or create environment ────────────────────────────────────────────
  useEffect(() => {
    getEnvironmentByTask(task.id).then((existing) => {
      if (existing) {
        setEnv(existing);
        // If there's a saved session in active/paused state, go straight to session
        if (existing.sessionStatus === "active" || existing.sessionStatus === "paused" || existing.sessionStatus === "break") {
          setElapsedSeconds(existing.timerElapsed);
          setSessionStatus(existing.sessionStatus);
          setPhase("session");
        }
      }
    });
  }, [task.id]);

  // ── Timer ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (sessionStatus === "active") {
      timerRef.current = window.setInterval(() => {
        setElapsedSeconds(s => s + 1);
      }, 1000);
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      if (sessionStatus === "break") {
        timerRef.current = window.setInterval(() => {
          setBreakSeconds(s => s + 1);
        }, 1000);
      }
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [sessionStatus]);

  // ── Autosave ──────────────────────────────────────────────────────────────
  const persistEnv = useCallback((updated: StudyEnvironment) => {
    setSaveIndicator("saving");
    if (saveDebounceRef.current) clearTimeout(saveDebounceRef.current);
    saveDebounceRef.current = setTimeout(async () => {
      await saveEnvironment(updated);
      setSaveIndicator("saved");
      setTimeout(() => setSaveIndicator(""), 1500);
    }, 400);
  }, []);

  const updateEnv = useCallback((patch: Partial<StudyEnvironment>) => {
    setEnv(prev => {
      if (!prev) return prev;
      const next = { ...prev, ...patch, lastSavedAt: new Date().toISOString() };
      persistEnv(next);
      return next;
    });
  }, [persistEnv]);

  // ── Audio control ─────────────────────────────────────────────────────────
  const setAudio = useCallback((type: string, volume: number, playing: boolean) => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (playing && type !== "silence") {
      const opt = AUDIO_OPTIONS.find(o => o.id === type);
      if (opt) {
        const audio = new Audio(opt.url);
        audio.loop = true;
        audio.volume = volume / 100;
        audio.play().catch(() => {});
        audioRef.current = audio;
      }
    }
    updateEnv({ audioType: type, audioVolume: volume, audioPlaying: playing });
  }, [updateEnv]);

  // ── Start session (from setup screen) ────────────────────────────────────
  const startSession = useCallback((materials: StudyMaterial[]) => {
    const envId = crypto.randomUUID();
    const template = detectTemplate(task);
    const artifacts = buildInitialArtifacts(template, envId, task.id, materials);
    const newEnv: StudyEnvironment = {
      id: envId,
      taskId: task.id,
      template,
      artifacts,
      notes: "",
      scratchpad: "",
      audioType: "silence",
      audioVolume: 50,
      audioPlaying: false,
      currentSubtaskIndex: doneSteps,
      timerElapsed: 0,
      sessionStatus: "active",
      lastSavedAt: new Date().toISOString(),
      materials,
    };
    setEnv(newEnv);
    setSessionStatus("active");
    setPhase("session");
    const logId = crypto.randomUUID();
    setSessionLog({
      id: logId,
      taskId: task.id,
      environmentId: envId,
      startedAt: new Date().toISOString(),
      elapsedSeconds: 0,
      breakSeconds: 0,
      completedSubtasks: [],
      submittedWork: [],
    });
    persistEnv(newEnv);
  }, [task, doneSteps, persistEnv]);

  // ── Resume saved session ──────────────────────────────────────────────────
  const resumeSession = useCallback(() => {
    if (!env) return;
    setSessionStatus("active");
    updateEnv({ sessionStatus: "active" });
  }, [env, updateEnv]);

  // ── Break ─────────────────────────────────────────────────────────────────
  const startBreak = useCallback(() => {
    setSessionStatus("break");
    updateEnv({ sessionStatus: "break", timerElapsed: elapsedSeconds });
  }, [elapsedSeconds, updateEnv]);

  const endBreak = useCallback(() => {
    setSessionStatus("active");
    updateEnv({ sessionStatus: "active" });
  }, [updateEnv]);

  // ── End session ───────────────────────────────────────────────────────────
  const endSession = useCallback(async () => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    if (env) {
      updateEnv({ sessionStatus: "ended", timerElapsed: elapsedSeconds });
      const finalLog: SessionLog = {
        ...sessionLog,
        endedAt: new Date().toISOString(),
        elapsedSeconds,
        breakSeconds,
      };
      await saveSession(finalLog);
    }
    onExit();
  }, [env, elapsedSeconds, breakSeconds, sessionLog, updateEnv, onExit]);

  // ── Subtask submit ────────────────────────────────────────────────────────
  const submitSubtask = useCallback((status: "completed" | "partial" | "stuck", note: string) => {
    if (!env) return;
    const idx = env.currentSubtaskIndex;
    setSessionLog(prev => ({
      ...prev,
      completedSubtasks: status === "completed" ? [...prev.completedSubtasks, idx] : prev.completedSubtasks,
      submittedWork: [...prev.submittedWork, { subtaskIndex: idx, status, note, at: new Date().toISOString() }],
    }));
    const nextIdx = idx + 1;
    updateEnv({ currentSubtaskIndex: nextIdx < totalSteps ? nextIdx : idx });
    setShowSubtaskSubmit(false);

    if (status === "stuck") setOpenPanel("ai");
  }, [env, totalSteps, updateEnv]);

  // ── Update artifacts ──────────────────────────────────────────────────────
  const updateArtifact = useCallback((id: string, patch: Partial<ArtifactState>) => {
    setEnv(prev => {
      if (!prev) return prev;
      const updated = {
        ...prev,
        artifacts: prev.artifacts.map(a => a.id === id ? { ...a, ...patch } : a),
        lastSavedAt: new Date().toISOString(),
      };
      persistEnv(updated);
      return updated;
    });
  }, [persistEnv]);

  const addArtifact = useCallback((artifact: ArtifactState) => {
    setEnv(prev => {
      if (!prev) return prev;
      const updated = { ...prev, artifacts: [...prev.artifacts, artifact], lastSavedAt: new Date().toISOString() };
      persistEnv(updated);
      return updated;
    });
  }, [persistEnv]);

  const removeArtifact = useCallback((id: string) => {
    setEnv(prev => {
      if (!prev) return prev;
      const updated = { ...prev, artifacts: prev.artifacts.filter(a => a.id !== id), lastSavedAt: new Date().toISOString() };
      persistEnv(updated);
      return updated;
    });
  }, [persistEnv]);

  // ── AI ────────────────────────────────────────────────────────────────────
  const sendAiMessage = useCallback(async (text: string) => {
    if (!text.trim() || !env) return;
    const userMsg = { role: "user" as const, text };
    setAiChat(prev => [...prev, userMsg]);
    try {
      const resp = await api.chat(task.id, text, env.currentSubtaskIndex);
      const reply = resp.chat?.[resp.chat.length - 1]?.role === "assistant"
        ? resp.chat[resp.chat.length - 1].text
        : "I couldn't generate a response.";
      setAiChat(prev => [...prev, { role: "assistant", text: reply }]);
    } catch {
      setAiChat(prev => [...prev, { role: "assistant", text: "I'm having trouble connecting. Please check your internet connection." }]);
    }
  }, [task, env]);

  // ── Format elapsed time ───────────────────────────────────────────────────
  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60).toString().padStart(2, "0");
    const s = (seconds % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  };

  // ── Phone block ───────────────────────────────────────────────────────────
  if (isPhone) {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100vh", padding: "32px", textAlign: "center", backgroundColor: "#0f0f0f", color: "#e0e0e0" }}>
        <div style={{ fontSize: "32px", marginBottom: "16px" }}>📱</div>
        <h2 style={{ marginBottom: "12px", fontWeight: 600 }}>Study Mode requires a larger screen</h2>
        <p style={{ color: "#888", lineHeight: 1.6, maxWidth: "300px" }}>Study Mode is designed for laptop and iPad. Continue using Otto on this device, and switch to a larger screen to start a study session.</p>
        <button onClick={onExit} style={{ marginTop: "24px", padding: "12px 24px", borderRadius: "8px", border: "1px solid #333", background: "none", color: "#e0e0e0", cursor: "pointer" }}>← Back to tasks</button>
      </div>
    );
  }

  // ── Setup screen ──────────────────────────────────────────────────────────
  if (phase === "setup") {
    return (
      <StudySetup
        task={task}
        existingEnv={env}
        onStart={startSession}
        onResume={env ? resumeSession : undefined}
        onExit={onExit}
      />
    );
  }

  if (!env) return null;

  const steps = task.steps || [];
  const currentStep = steps[env.currentSubtaskIndex];
  const progressPct = totalSteps > 0 ? Math.round((env.currentSubtaskIndex / totalSteps) * 100) : 0;

  // ── Break screen ──────────────────────────────────────────────────────────
  if (sessionStatus === "break") {
    return (
      <BreakScreen
        elapsed={breakSeconds}
        formatTime={formatTime}
        onResume={endBreak}
        onEnd={() => setShowEndModal(true)}
      />
    );
  }

  return (
    <div className="sm-shell" data-status={sessionStatus}>
      {/* ── Save indicator ── */}
      {saveIndicator && (
        <div className="sm-save-indicator">{saveIndicator === "saving" ? "Saving…" : "Saved"}</div>
      )}

      {/* ── Session header ── */}
      <SessionHeader
        taskTitle={task.title}
        currentStep={currentStep}
        stepIndex={env.currentSubtaskIndex}
        totalSteps={totalSteps}
        progress={progressPct}
        elapsed={elapsedSeconds}
        formatTime={formatTime}
        onBack={onExit}
        onSubmitStep={() => setShowSubtaskSubmit(true)}
        sessionStatus={sessionStatus}
      />

      {/* ── Main artifact canvas ── */}
      <ArtifactCanvas
        artifacts={env.artifacts}
        notes={env.notes}
        scratchpad={env.scratchpad}
        taskId={task.id}
        environmentId={env.id}
        onUpdateArtifact={updateArtifact}
        onAddArtifact={addArtifact}
        onRemoveArtifact={removeArtifact}
        onNotesChange={(notes) => updateEnv({ notes })}
        onScratchpadChange={(scratchpad) => updateEnv({ scratchpad })}
      />

      {/* ── Bottom bar ── */}
      <BottomBar
        openPanel={openPanel}
        onPanelToggle={(p) => setOpenPanel(prev => prev === p ? null : p)}
        onBreak={startBreak}
        onEnd={() => setShowEndModal(true)}
        audioPlaying={env.audioPlaying}
        sessionStatus={sessionStatus}
        onPauseResume={() => {
          const next = sessionStatus === "active" ? "paused" : "active";
          setSessionStatus(next);
          updateEnv({ sessionStatus: next });
        }}
      />

      {/* ── Panels (Layer 2) ── */}
      {openPanel === "materials" && (
        <MaterialsDrawer
          materials={env.materials}
          onClose={() => setOpenPanel(null)}
          onOpenArtifact={(mat) => {
            const newArtifact: ArtifactState = {
              id: crypto.randomUUID(),
              type: mat.type === "pdf" ? "pdf" : mat.type === "video" ? "video" : mat.type === "image" ? "image" : mat.type === "note" ? "sticky" : "document",
              title: mat.label,
              x: 15, y: 15,
              width: 60, height: 75,
              zIndex: 100,
              minimized: false,
              maximized: false,
              dockSide: "none",
              contentState: mat.text ? { text: mat.text } : {},
              source: mat.objectUrl || mat.url,
              sourceLabel: mat.label,
              taskId: task.id,
              environmentId: env.id,
            };
            addArtifact(newArtifact);
            setOpenPanel(null);
          }}
        />
      )}

      {openPanel === "tools" && (
        <ToolsDrawer
          template={env.template}
          onClose={() => setOpenPanel(null)}
          onAddTool={(type) => {
            const newArtifact: ArtifactState = {
              id: crypto.randomUUID(),
              type,
              title: type === "calculator" ? "Calculator" : type === "desmos" ? "Desmos" : type === "dictionary" ? "Dictionary" : type === "whiteboard" ? "Whiteboard" : type === "sticky" ? "Sticky Note" : type === "scratchpad" ? "Scratchpad" : "Notes",
              x: 20, y: 15,
              width: type === "calculator" ? 25 : type === "dictionary" ? 32 : type === "desmos" ? 55 : type === "whiteboard" ? 65 : 40,
              height: type === "calculator" ? 45 : type === "dictionary" ? 58 : type === "desmos" ? 65 : type === "whiteboard" ? 65 : 50,
              zIndex: 100,
              minimized: false,
              maximized: false,
              dockSide: "none",
              contentState: {},
              taskId: task.id,
              environmentId: env.id,
            };
            addArtifact(newArtifact);
            setOpenPanel(null);
          }}
        />
      )}

      {openPanel === "audio" && (
        <AudioPanel
          audioType={env.audioType}
          volume={env.audioVolume}
          playing={env.audioPlaying}
          onClose={() => setOpenPanel(null)}
          onChange={setAudio}
        />
      )}

      {openPanel === "ai" && (
        <AskOttoPanel
          chat={aiChat}
          onSend={sendAiMessage}
          onClose={() => setOpenPanel(null)}
          task={task}
          currentStep={currentStep}
        />
      )}

      {/* ── Subtask submit modal ── */}
      {showSubtaskSubmit && currentStep && (
        <SubtaskSubmit
          stepText={currentStep.text}
          stepIndex={env.currentSubtaskIndex}
          totalSteps={totalSteps}
          onSubmit={submitSubtask}
          onCancel={() => setShowSubtaskSubmit(false)}
        />
      )}

      {/* ── End session modal ── */}
      {showEndModal && (
        <EndSessionModal
          completedSteps={sessionLog.completedSubtasks.length}
          totalSteps={totalSteps}
          elapsed={elapsedSeconds}
          formatTime={formatTime}
          onContinue={() => setShowEndModal(false)}
          onEnd={endSession}
        />
      )}
    </div>
  );
}
