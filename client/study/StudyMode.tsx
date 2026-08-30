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
import { getEnvironmentByTask, saveEnvironment, saveSession, saveFile, getFile, deleteFile } from "./StudyDB.ts";
import { StudySetup, type PomodoroChoice } from "./StudySetup.tsx";
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
import { NoisePlayer, type NoiseType } from "./noise.ts";

interface StudyModeProps {
  task: WebTask;
  onExit: () => void;
  /** Merges the server's returned task back into the shared task list — a tutor turn can create notes/
   *  decks/quizzes and updates task.chat itself, so App.tsx's list must reflect it (same "the whole app
   *  sees this" merge TaskCard.tsx's own onTask callback does), not just a chat bubble in a local echo. */
  onTaskUpdate: (t: WebTask) => void;
  userId?: string;
  language?: "fr" | "en";
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

// ── Audio ─────────────────────────────────────────────────────────────────────
// Synthesized in-browser (see noise.ts) instead of streaming third-party MP3s — the previous pixabay CDN
// hotlinks were observed live returning 403 (expired/hotlink-blocked) for at least one track, so "audio"
// silently failed depending on which one was picked. A generated waveform can never fail to load.
export const AUDIO_OPTIONS: { id: NoiseType; label: string }[] = [
  { id: "brown", label: "Brown noise" },
  { id: "pink", label: "Pink noise" },
  { id: "white", label: "White noise" },
];

// ── Main StudyMode component ───────────────────────────────────────────────────
export function StudyMode({ task, onExit, onTaskUpdate, userId, language = "fr" }: StudyModeProps) {
  const [phase, setPhase] = useState<"setup" | "session">("setup");
  const [env, setEnv] = useState<StudyEnvironment | null>(null);
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>("idle");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [breakSeconds, setBreakSeconds] = useState(0);
  const [phaseSeconds, setPhaseSeconds] = useState(0); // seconds within the current pomodoro work/break phase
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
  // Ask Otto — mirrors TaskCard.tsx's TaskChat exactly (same server endpoint, same pending/slow/typing/
  // error-retry state machine) so a student gets the identical tutoring experience whether they're on the
  // main task card or inside Study Mode. task.chat itself (via onTaskUpdate) is the source of truth, not a
  // separate local echo — a tutor turn can create notes/decks/quizzes, and those need to reach the rest of
  // the app (Materials drawer, the main task card) the same way TaskChat's onTask merge does.
  const [chatInput, setChatInput] = useState("");
  const [chatSending, setChatSending] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [pendingMsg, setPendingMsg] = useState<string | null>(null);
  const [chatSlow, setChatSlow] = useState(false);
  const [chatVerySlow, setChatVerySlow] = useState(false);
  useEffect(() => {
    if (!chatSending) { setChatSlow(false); setChatVerySlow(false); return; }
    const id1 = setTimeout(() => setChatSlow(true), 6000);
    const id2 = setTimeout(() => setChatVerySlow(true), 15000);
    return () => { clearTimeout(id1); clearTimeout(id2); };
  }, [chatSending]);
  const [saveIndicator, setSaveIndicator] = useState<"saved" | "saving" | "">("");
  const [isFullscreen, setIsFullscreen] = useState(false);

  const timerRef = useRef<number | null>(null);
  const noiseRef = useRef<NoisePlayer | null>(null);
  const customAudioRef = useRef<HTMLAudioElement | null>(null);
  const customAudioUrlRef = useRef<string | null>(null); // revoke on replace/unmount
  const rootRef = useRef<HTMLDivElement>(null);
  const saveDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Fullscreen: "genuinely full-screen" means the OS chrome/browser tabs disappear too, not just our
  // own layout filling the viewport — requestFullscreen is what actually does that. Best-effort: some
  // browsers/contexts (iOS Safari on non-video elements, a denied permission) reject the request, so this
  // never blocks entering Study Mode itself — it degrades to the plain full-viewport layout underneath.
  const enterFullscreen = useCallback(() => {
    const el = rootRef.current;
    if (el && !document.fullscreenElement) void el.requestFullscreen?.().catch(() => {});
  }, []);
  const exitFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => {});
  }, []);
  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

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

  // ── Timer ─────────────────────────────────────────────────────────────────
  // Pomodoro (when enabled) auto-alternates active↔break by watching `phaseSeconds` — a counter reset on
  // every phase change, kept separate from elapsedSeconds/breakSeconds (which track SESSION totals and
  // must keep counting across cycles, not reset each time a break starts).
  useEffect(() => {
    if (sessionStatus === "active") {
      timerRef.current = window.setInterval(() => {
        setElapsedSeconds(s => s + 1);
        setPhaseSeconds(s => {
          const next = s + 1;
          if (env?.pomodoroEnabled && next >= (env.pomodoroWorkMinutes || 25) * 60) {
            setSessionStatus("break");
            setBreakSeconds(0);
            updateEnv({ sessionStatus: "break", pomodoroCycles: (env.pomodoroCycles || 0) + 1 });
            return 0;
          }
          return next;
        });
      }, 1000);
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      if (sessionStatus === "break") {
        timerRef.current = window.setInterval(() => {
          setBreakSeconds(s => s + 1);
          setPhaseSeconds(s => {
            const next = s + 1;
            if (env?.pomodoroEnabled && next >= (env.pomodoroBreakMinutes || 5) * 60) {
              setSessionStatus("active");
              updateEnv({ sessionStatus: "active" });
              return 0;
            }
            return next;
          });
        }, 1000);
      }
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [sessionStatus, env?.pomodoroEnabled, env?.pomodoroWorkMinutes, env?.pomodoroBreakMinutes, updateEnv]);

  // ── Audio control ─────────────────────────────────────────────────────────
  // Uploaded audio plays through a plain HTMLAudioElement from a local Blob (never re-fetched over the
  // network, so it can't hit the CSP/CORS issues an external stream would) — separate from NoisePlayer's
  // Web Audio synthesis, which only knows how to generate noise, not decode a music file.
  const stopCustomAudio = useCallback(() => {
    if (customAudioRef.current) { customAudioRef.current.pause(); customAudioRef.current.src = ""; }
    if (customAudioUrlRef.current) { URL.revokeObjectURL(customAudioUrlRef.current); customAudioUrlRef.current = null; }
  }, []);

  const playCustomBlob = useCallback((blob: Blob, volume: number) => {
    stopCustomAudio();
    const url = URL.createObjectURL(blob);
    customAudioUrlRef.current = url;
    const audio = (customAudioRef.current ||= new Audio());
    audio.src = url;
    audio.loop = true;
    audio.volume = Math.max(0, Math.min(1, volume / 100));
    void audio.play().catch(() => {});
  }, [stopCustomAudio]);

  const setAudio = useCallback((type: string, volume: number, playing: boolean) => {
    const noise = (noiseRef.current ||= new NoisePlayer());
    if (!playing || type === "silence") {
      noise.stop();
      stopCustomAudio();
      updateEnv({ audioType: type, audioVolume: volume, audioPlaying: playing });
      return;
    }
    const sameTrackAlreadyPlaying = env?.audioPlaying && env?.audioType === type;
    if (type === "spotify") {
      // Spotify's own embed widget owns playback (its own play/pause/volume) — we just stop our other
      // sources and let the iframe render; there's nothing for us to programmatically start.
      noise.stop();
      stopCustomAudio();
    } else if (type === "custom") {
      if (sameTrackAlreadyPlaying && customAudioRef.current) {
        customAudioRef.current.volume = Math.max(0, Math.min(1, volume / 100));
      } else if (env?.customAudioFileId) {
        noise.stop();
        void getFile(env.customAudioFileId).then((blob) => { if (blob) playCustomBlob(blob, volume); });
      }
    } else if (AUDIO_OPTIONS.some(o => o.id === type)) {
      if (sameTrackAlreadyPlaying) {
        noise.setVolume(volume); // volume-only change (slider drag) — don't restart the noise loop
      } else {
        stopCustomAudio();
        noise.play(type as NoiseType, volume);
      }
    }
    updateEnv({ audioType: type, audioVolume: volume, audioPlaying: playing });
  }, [updateEnv, env?.audioPlaying, env?.audioType, env?.customAudioFileId, stopCustomAudio, playCustomBlob]);

  // A fresh upload replaces whatever track was previously stored for this task (one custom track at a
  // time keeps this simple, and avoids silently accumulating orphaned blobs in IndexedDB).
  const uploadAudio = useCallback(async (file: File) => {
    const oldId = env?.customAudioFileId;
    const id = crypto.randomUUID();
    await saveFile(id, file);
    if (oldId) void deleteFile(oldId).catch(() => {});
    noiseRef.current?.stop();
    playCustomBlob(file, env?.audioVolume ?? 50);
    updateEnv({ audioType: "custom", customAudioFileId: id, customAudioName: file.name, audioPlaying: true });
  }, [env?.customAudioFileId, env?.audioVolume, updateEnv, playCustomBlob]);

  const setSpotify = useCallback((embedUrl: string) => {
    noiseRef.current?.stop();
    stopCustomAudio();
    updateEnv({ audioType: "spotify", spotifyEmbedUrl: embedUrl, audioPlaying: true });
  }, [updateEnv, stopCustomAudio]);

  useEffect(() => () => { noiseRef.current?.stop(); stopCustomAudio(); }, [stopCustomAudio]);

  // ── Start session (from setup screen) ────────────────────────────────────
  const startSession = useCallback((materials: StudyMaterial[], pomodoro: PomodoroChoice) => {
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
      pomodoroEnabled: pomodoro.enabled,
      pomodoroWorkMinutes: pomodoro.workMinutes,
      pomodoroBreakMinutes: pomodoro.breakMinutes,
      pomodoroCycles: 0,
    };
    setEnv(newEnv);
    setSessionStatus("active");
    setElapsedSeconds(0);
    setPhaseSeconds(0);
    setPhase("session");
    enterFullscreen(); // called synchronously from the Start button's click, so the browser's user-gesture requirement is satisfied
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
  }, [task, doneSteps, persistEnv, enterFullscreen]);

  // ── Resume saved session ──────────────────────────────────────────────────
  const resumeSession = useCallback(() => {
    if (!env) return;
    setSessionStatus("active");
    setPhaseSeconds(0);
    setPhase("session"); // was missing — clicking "Resume" flipped status but left the setup screen on-screen
    updateEnv({ sessionStatus: "active" });
    enterFullscreen(); // called synchronously from the Resume button's click
  }, [env, updateEnv, enterFullscreen]);

  // ── Break ─────────────────────────────────────────────────────────────────
  const startBreak = useCallback(() => {
    setSessionStatus("break");
    setBreakSeconds(0);
    setPhaseSeconds(0); // manual break — don't let a stale pomodoro phase count trigger another transition right away
    updateEnv({ sessionStatus: "break", timerElapsed: elapsedSeconds });
  }, [elapsedSeconds, updateEnv]);

  const endBreak = useCallback(() => {
    setSessionStatus("active");
    setPhaseSeconds(0);
    updateEnv({ sessionStatus: "active" });
  }, [updateEnv]);

  // ── End session ───────────────────────────────────────────────────────────
  const endSession = useCallback(async () => {
    if (timerRef.current) clearInterval(timerRef.current);
    noiseRef.current?.stop();
    stopCustomAudio();
    exitFullscreen();
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
  }, [env, elapsedSeconds, breakSeconds, sessionLog, updateEnv, onExit, exitFullscreen, stopCustomAudio]);

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

  // A tutor turn can create a note/deck/quiz and reference it as a chip in the chat thread (same as
  // TaskCard.tsx's chat) — clicking one opens it as a real artifact on the desk, same code path as opening
  // a material from the Materials drawer.
  const openArtifactByKind = useCallback((kind: "note" | "deck" | "quiz", id: string, title: string) => {
    if (!env) return;
    const type = kind === "note" ? "sticky" : kind === "deck" ? "flashcard" : "quiz";
    const contentState = kind === "note" ? { text: task.notes?.find(n => n.id === id)?.body || "" }
      : kind === "deck" ? { deckId: id } : { quizId: id };
    addArtifact({
      id: crypto.randomUUID(), type, title, x: 15, y: 15, width: 60, height: 75, zIndex: 100,
      minimized: false, maximized: false, dockSide: "none", contentState,
      taskId: task.id, environmentId: env.id,
    });
    setOpenPanel(null);
  }, [env, task, addArtifact]);

  const removeArtifact = useCallback((id: string) => {
    setEnv(prev => {
      if (!prev) return prev;
      const updated = { ...prev, artifacts: prev.artifacts.filter(a => a.id !== id), lastSavedAt: new Date().toISOString() };
      persistEnv(updated);
      return updated;
    });
  }, [persistEnv]);

  // ── Ask Otto ──────────────────────────────────────────────────────────────
  const sendChat = useCallback(async () => {
    const message = chatInput.trim();
    if (!message || chatSending || !env) return;
    const stepIndex = env.currentSubtaskIndex;
    setChatInput(""); setChatSending(true); setChatError(null); setPendingMsg(message);
    try {
      const { task: updated } = await api.chat(task.id, message, stepIndex);
      onTaskUpdate({ ...task, ...updated });
    } catch (e: any) {
      setChatError(e?.message || "Couldn't send that — try again.");
      setChatInput(message);
    } finally {
      setChatSending(false);
      setPendingMsg(null);
    }
  }, [chatInput, chatSending, env, task, onTaskUpdate]);

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
        countdownRemaining={env?.pomodoroEnabled ? Math.max(0, (env.pomodoroBreakMinutes || 5) * 60 - phaseSeconds) : undefined}
      />
    );
  }

  return (
    <div className="sm-shell" data-status={sessionStatus} ref={rootRef}>
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
        onBack={() => { exitFullscreen(); onExit(); }}
        onSubmitStep={() => setShowSubtaskSubmit(true)}
        sessionStatus={sessionStatus}
        isFullscreen={isFullscreen}
        onToggleFullscreen={() => (isFullscreen ? exitFullscreen() : enterFullscreen())}
        pomodoroRemaining={env.pomodoroEnabled ? Math.max(0, (env.pomodoroWorkMinutes || 25) * 60 - phaseSeconds) : undefined}
        pomodoroCycle={env.pomodoroCycles}
      />

      {/* ── Main artifact canvas ── */}
      <ArtifactCanvas
        artifacts={env.artifacts}
        notes={env.notes}
        scratchpad={env.scratchpad}
        task={task}
        taskId={task.id}
        environmentId={env.id}
        onUpdateArtifact={updateArtifact}
        onAddArtifact={addArtifact}
        onRemoveArtifact={removeArtifact}
        onNotesChange={(notes) => updateEnv({ notes })}
        onScratchpadChange={(scratchpad) => updateEnv({ scratchpad })}
        language={language}
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
            const type = mat.type === "pdf" ? "pdf" : mat.type === "video" ? "video" : mat.type === "image" ? "image"
              : mat.type === "note" ? "sticky" : mat.type === "flashcard" ? "flashcard" : mat.type === "quiz" ? "quiz" : "document";
            // For flashcard/quiz materials, buildTaskMaterials (StudySetup.tsx) stashed the deck/quiz id in
            // `text` (there's no file/url for these — they live on the task itself) — thread it through as
            // the id the artifact looks the real deck/quiz up by, not literal note text.
            const contentState = mat.type === "flashcard" ? { deckId: mat.text } : mat.type === "quiz" ? { quizId: mat.text } : mat.text ? { text: mat.text } : {};
            const newArtifact: ArtifactState = {
              id: crypto.randomUUID(),
              type,
              title: mat.label,
              x: 15, y: 15,
              width: 60, height: 75,
              zIndex: 100,
              minimized: false,
              maximized: false,
              dockSide: "none",
              contentState,
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
          customAudioName={env.customAudioName}
          spotifyEmbedUrl={env.spotifyEmbedUrl}
          onClose={() => setOpenPanel(null)}
          onChange={setAudio}
          onUploadAudio={(file) => void uploadAudio(file)}
          onSetSpotify={setSpotify}
        />
      )}

      {openPanel === "ai" && (
        <AskOttoPanel
          task={task}
          currentStep={currentStep}
          input={chatInput}
          setInput={setChatInput}
          sending={chatSending}
          error={chatError}
          pendingMsg={pendingMsg}
          slow={chatSlow}
          verySlow={chatVerySlow}
          onSend={sendChat}
          onClose={() => setOpenPanel(null)}
          onOpenNote={(id, title) => openArtifactByKind("note", id, title)}
          onOpenDeck={(id, title) => openArtifactByKind("deck", id, title)}
          onOpenQuiz={(id, title) => openArtifactByKind("quiz", id, title)}
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
