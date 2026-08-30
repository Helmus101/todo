import { useState, useEffect, useCallback, useRef } from "react";
import type { WebTask, StudySession, StudyProfile, StudyMaterial, StudyNote, StudyModeState, TimerStyle, StudyEnvironmentState } from "../shared/types.ts";
import { api } from "./api.ts";

import { WritingWorkspace, ResearchWorkspace, ProblemSolvingWorkspace } from "./workspaces";
interface StudyModeProps {
  task: WebTask;
  onExit: () => void;
  userId?: string;
}

export function StudyMode({ task, onExit, userId }: StudyModeProps) {
  const [sessionState, setSessionState] = useState<StudyModeState>("idle");
  const [session, setSession] = useState<StudySession | null>(null);
  const [profile, setProfile] = useState<StudyProfile | null>(null);
  const [timeRemaining, setTimeRemaining] = useState<number>(0); // in seconds
  const [materialsOpen, setMaterialsOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [notes, setNotes] = useState<string>("");
  const [materials, setMaterials] = useState<StudyMaterial[]>([]);
  const [showReflection, setShowReflection] = useState(false);
  const [audioPlaying, setAudioPlaying] = useState(false);
  const [audioType, setAudioType] = useState<string>("silence");
  const [audioVolume, setAudioVolume] = useState(50);
  const [aiChat, setAiChat] = useState<{ role: "user" | "assistant"; text: string }[]>([]);
  const [aiInput, setAiInput] = useState<string>("");
  const [aiLoading, setAiLoading] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [focusLevel, setFocusLevel] = useState<"strict" | "balanced" | "open">("balanced");
  const [showObjective, setShowObjective] = useState(true);
  const [inactiveTime, setInactiveTime] = useState(0);
  const [showInactivePrompt, setShowInactivePrompt] = useState(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [commandPaletteQuery, setCommandPaletteQuery] = useState("");
  const [envState, setEnvState] = useState<StudyEnvironmentState | null>(null);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [showAiMenu, setShowAiMenu] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [showAudioPanel, setShowAudioPanel] = useState(false);
  const [showFocusPanel, setShowFocusPanel] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Array<{ title: string; url: string; snippet: string }>>([]);
  const [browserUrl, setBrowserUrl] = useState("");
  const [browserHistory, setBrowserHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  
  const timerRef = useRef<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const inactiveRef = useRef<number | null>(null);

  // Load study profile on mount
  useEffect(() => {
    api.studyProfile().then(setProfile).catch(() => {
      // If no profile exists, create a default one
      const defaultProfile: StudyProfile = {
        userId: userId || "",
        preferredSessionLength: 45,
        preferredBreakLength: 5,
        prefersPomodoro: false,
        uninterruptedSessions: false,
        timerStyle: "minimal",
        showTimer: true,
        showSidebar: true,
        animationLevel: "minimal",
        audioType: "silence",
        volume: 50,
        notesPosition: "right",
        materialsPosition: "left",
        aiVisibility: "on_request",
        focusLevel: "balanced",
        updatedAt: new Date().toISOString(),
      };
      setProfile(defaultProfile);
    });

    // Check for persisted environment state for this task
    try {
      const savedEnvState = localStorage.getItem(`study-env-${task.id}`);
      if (savedEnvState) {
        const parsed = JSON.parse(savedEnvState);
        // Only restore if within last 7 days
        if (Date.now() - Date.parse(parsed.lastSaved) < 7 * 24 * 60 * 60 * 1000) {
          setEnvState(parsed);
          setNotes(parsed.notes || "");
          setMaterials(parsed.openResources || []);
          setAudioType(parsed.audio.type || "silence");
          setAudioVolume(parsed.audio.volume || 50);
          setFocusLevel(parsed.focusLevel || "balanced");
          setActiveTab(parsed.activeTab || null);
          
          // Restore session state if active
          if (parsed.timer.state === "active") {
            setSessionState(parsed.timer.state);
            setTimeRemaining(parsed.timer.remaining);
            setSession({
              id: crypto.randomUUID(),
              taskId: task.id,
              userId: userId || "",
              startTime: new Date().toISOString(),
              plannedDuration: parsed.timer.plannedDuration,
              state: parsed.timer.state,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
            
            timerRef.current = window.setInterval(() => {
              setTimeRemaining((prev) => {
                if (prev <= 1) {
                  completeSession();
                  return 0;
                }
                return prev - 1;
              });
            }, 1000);
          }
        }
      }
    } catch (e) {
      console.error("Failed to restore environment state:", e);
    }
  }, [userId, task.id]);

  // Audio URLs (using free ambient sounds)
  const audioUrls: Record<string, string> = {
    brown: "https://cdn.pixabay.com/audio/2022/01/18/audio_d0a13f69d2.mp3", // Brown noise
    rain: "https://cdn.pixabay.com/audio/2021/08/09/audio_0124f52e0c.mp3", // Rain
    cafe: "https://cdn.pixabay.com/audio/2022/03/10/audio_c8c8a73467.mp3", // Cafe ambience
    classical: "https://cdn.pixabay.com/audio/2022/05/27/audio_1808fbf07a.mp3", // Classical
    lofi: "https://cdn.pixabay.com/audio/2022/05/27/audio_1808fbf07a.mp3", // Using classical as placeholder for lofi
  };

  // Audio playback control
  const toggleAudio = useCallback(() => {
    if (audioPlaying) {
      audioRef.current?.pause();
      setAudioPlaying(false);
    } else {
      if (audioType !== "silence" && audioUrls[audioType]) {
        if (!audioRef.current) {
          audioRef.current = new Audio(audioUrls[audioType]);
          audioRef.current.loop = true;
          audioRef.current.volume = audioVolume / 100;
          audioRef.current.addEventListener('error', () => {
            console.error('Audio failed to load');
            setAudioPlaying(false);
          });
        }
        audioRef.current.play().catch((err) => {
          console.error('Audio playback failed:', err);
          setAudioPlaying(false);
        });
        setAudioPlaying(true);
      }
    }
  }, [audioPlaying, audioType, audioVolume]);

  const changeAudioType = useCallback((type: string) => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    setAudioPlaying(false);
    setAudioType(type);
    if (type !== "silence" && audioUrls[type]) {
      audioRef.current = new Audio(audioUrls[type]);
      audioRef.current.loop = true;
      audioRef.current.volume = audioVolume / 100;
      audioRef.current.addEventListener('error', () => {
        console.error('Audio failed to load');
        setAudioPlaying(false);
      });
      audioRef.current.play().catch((err) => {
        console.error('Audio playback failed:', err);
        setAudioPlaying(false);
      });
      setAudioPlaying(true);
    }
  }, [audioVolume]);

  const changeVolume = useCallback((vol: number) => {
    setAudioVolume(vol);
    if (audioRef.current) {
      audioRef.current.volume = vol / 100;
    }
  }, []);

  // Cleanup audio on unmount
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      if (inactiveRef.current) {
        clearInterval(inactiveRef.current);
      }
    };
  }, []);

  // Fullscreen toggle
  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().then(() => setIsFullscreen(true));
    } else {
      document.exitFullscreen().then(() => setIsFullscreen(false));
    }
  }, []);

  // Listen for fullscreen changes
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  // Inactivity detection
  useEffect(() => {
    if (sessionState !== "active") return;
    
    const resetInactiveTimer = () => {
      setInactiveTime(0);
      setShowInactivePrompt(false);
    };

    const handleActivity = () => {
      resetInactiveTimer();
    };

    // Track activity
    window.addEventListener("mousemove", handleActivity);
    window.addEventListener("keydown", handleActivity);
    window.addEventListener("click", handleActivity);

    inactiveRef.current = window.setInterval(() => {
      setInactiveTime((prev) => {
        const newTime = prev + 1;
        // Show prompt after 7 minutes of inactivity
        if (newTime === 420 && !showInactivePrompt) {
          setShowInactivePrompt(true);
        }
        return newTime;
      });
    }, 1000);

    return () => {
      window.removeEventListener("mousemove", handleActivity);
      window.removeEventListener("keydown", handleActivity);
      window.removeEventListener("click", handleActivity);
      if (inactiveRef.current) {
        clearInterval(inactiveRef.current);
      }
    };
  }, [sessionState, showInactivePrompt]);

  // Initialize session
  const startSession = useCallback(async (duration: number) => {
    const newSession: StudySession = {
      id: crypto.randomUUID(),
      taskId: task.id,
      userId: userId || "",
      startTime: new Date().toISOString(),
      plannedDuration: duration,
      state: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    setSession(newSession);
    setSessionState("active");
    setTimeRemaining(duration * 60);
    
    // Auto-populate materials from task context with intelligence ranking
    const taskMaterials: StudyMaterial[] = [];
    const essentialMaterials: StudyMaterial[] = [];
    
    // Add task links (docs, resources Otto created)
    if (task.links) {
      task.links.forEach((link, idx) => {
        const material: StudyMaterial = {
          id: `link-${idx}`,
          label: link.label,
          url: link.url,
          type: "link",
          relevance: "high",
        };
        taskMaterials.push(material);
        if (idx === 0) essentialMaterials.push(material);
      });
    }
    
    // Add evidence (source documents)
    if (task.evidence) {
      task.evidence.forEach((ev, idx) => {
        const material: StudyMaterial = {
          id: `evidence-${idx}`,
          label: ev.label,
          url: ev.url,
          type: "doc",
          relevance: "high",
          source: task.source,
        };
        taskMaterials.push(material);
        if (idx === 0) essentialMaterials.push(material);
      });
    }
    
    // Add artifacts (docs, sheets, slides, drafts)
    if (task.artifacts) {
      task.artifacts.forEach((art, idx) => {
        const material: StudyMaterial = {
          id: `artifact-${idx}`,
          label: art.label || `${art.kind}`,
          url: art.url,
          type: art.kind === "draft" ? "email" : "doc",
          relevance: "high",
          source: task.source,
        };
        taskMaterials.push(material);
        if (idx === 0) essentialMaterials.push(material);
      });
    }
    
    setMaterials(taskMaterials);
    
    // Determine layout based on task type
    let detectedLayout: "writing" | "research" | "math" | "reading" | "standard" = "standard";
    const taskTitle = task.title.toLowerCase();
    const taskWhy = (task.why || "").toLowerCase();
    
    if (taskTitle.includes("essay") || taskTitle.includes("write") || taskTitle.includes("draft") || 
        taskWhy.includes("write") || taskWhy.includes("essay")) {
      detectedLayout = "writing";
    } else if (taskTitle.includes("research") || taskTitle.includes("find") || 
               taskWhy.includes("research") || taskWhy.includes("find")) {
      detectedLayout = "research";
    } else if (taskTitle.includes("math") || taskTitle.includes("problem") || taskTitle.includes("solve") ||
               taskWhy.includes("math") || taskWhy.includes("problem") || taskWhy.includes("solve")) {
      detectedLayout = "math";
    } else if (taskTitle.includes("read") || taskTitle.includes("chapter") || taskTitle.includes("book") ||
               taskWhy.includes("read") || taskWhy.includes("chapter")) {
      detectedLayout = "reading";
    }
    
    // Create environment state
    const newEnvState: StudyEnvironmentState = {
      task: task.id,
      layout: detectedLayout,
      workspaceType: essentialMaterials.length > 0 ? "document" : "empty",
      openResources: taskMaterials,
      openTabs: essentialMaterials.map((m, idx) => ({
        id: m.id,
        title: m.label,
        url: m.url || "",
        active: idx === 0,
      })),
      activeResource: essentialMaterials[0]?.id || null,
      notes: "",
      audio: {
        type: profile?.audioType || "silence",
        volume: profile?.volume || 50,
        playing: false,
      },
      focusLevel: profile?.focusLevel || "balanced",
      timer: {
        state: "active",
        remaining: duration * 60,
        plannedDuration: duration,
      },
      aiVisibility: "hidden",
      browserPermissions: {
        allowedDomains: [],
        restrictedDomains: ["facebook.com", "twitter.com", "instagram.com", "youtube.com", "reddit.com"],
      },
      userPreferences: {
        preferredLayout: detectedLayout,
        preferredAudio: profile?.audioType || "silence",
        preferredFocusLevel: profile?.focusLevel || "balanced",
        showTimer: true,
        showNotes: false,
      },
      lastSaved: new Date().toISOString(),
    };
    
    setEnvState(newEnvState);
    
    if (essentialMaterials.length > 0) {
      setActiveTab(essentialMaterials[0].id);
    }
    
    try {
      const savedSession = await api.saveStudySession(newSession);
      setSession(savedSession);
    } catch (e) {
      console.error("Failed to save study session:", e);
    }
    
    timerRef.current = window.setInterval(() => {
      setTimeRemaining((prev) => {
        if (prev <= 1) {
          completeSession();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }, [task.id, userId, task.links, task.evidence, task.artifacts, task.source, task.title, task.why, profile]);

  const pauseSession = useCallback(() => {
    setSessionState("paused");
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const resumeSession = useCallback(() => {
    setSessionState("active");
    timerRef.current = window.setInterval(() => {
      setTimeRemaining((prev) => {
        if (prev <= 1) {
          completeSession();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }, []);

  const startBreak = useCallback(() => {
    setSessionState("break");
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setTimeRemaining(profile?.preferredBreakLength || 5 * 60);
    timerRef.current = window.setInterval(() => {
      setTimeRemaining((prev) => {
        if (prev <= 1) {
          completeSession();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }, [profile?.preferredBreakLength]);

  const completeSession = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setSessionState("completed");
    setShowReflection(true);
  }, []);

  // Keyboard shortcuts (moved after function definitions to avoid initialization error)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if typing in an input field
      if ((e.target as HTMLElement).tagName === "INPUT" || (e.target as HTMLElement).tagName === "TEXTAREA") {
        return;
      }

      switch (e.key) {
        case " ":
          e.preventDefault();
          sessionState === "active" ? pauseSession() : resumeSession();
          break;
        case "n":
        case "N":
          setNotesOpen(!notesOpen);
          break;
        case "m":
        case "M":
          setMaterialsOpen(!materialsOpen);
          break;
        case "a":
        case "A":
          setAiOpen(!aiOpen);
          break;
        case "b":
        case "B":
          if (sessionState === "active") startBreak();
          break;
        case "Escape":
          setNotesOpen(false);
          setMaterialsOpen(false);
          setAiOpen(false);
          setShowInactivePrompt(false);
          setShowCommandPalette(false);
          break;
        case "k":
          if ((e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            setShowCommandPalette(true);
            setCommandPaletteQuery("");
          }
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [sessionState, notesOpen, materialsOpen, aiOpen, pauseSession, resumeSession, startBreak, showInactivePrompt]);

  const exitSession = useCallback((reason?: string) => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    
    // Save environment state for restoration
    if (envState) {
      try {
        const updatedEnvState: StudyEnvironmentState = {
          ...envState,
          notes,
          openResources: materials,
          audio: {
            type: audioType,
            volume: audioVolume,
            playing: audioPlaying,
          },
          focusLevel,
          timer: {
            state: sessionState,
            remaining: timeRemaining,
            plannedDuration: envState.timer.plannedDuration,
          },
          activeTab,
          lastSaved: new Date().toISOString(),
        };
        localStorage.setItem(`study-env-${task.id}`, JSON.stringify(updatedEnvState));
      } catch (e) {
        console.error("Failed to save environment state:", e);
      }
    }
    
    onExit();
  }, [envState, sessionState, timeRemaining, notes, materials, audioType, audioVolume, audioPlaying, focusLevel, activeTab, task.id, onExit]);

  const submitReflection = useCallback(async (reflection: "good" | "okay" | "difficult") => {
    if (session) {
      const completedSession: StudySession = {
        ...session,
        endTime: new Date().toISOString(),
        actualDuration: session.plannedDuration - timeRemaining / 60,
        state: "completed",
        reflection,
        notes,
        updatedAt: new Date().toISOString(),
      };
      setSession(completedSession);
      
      // Save completed session to API
      try {
        await api.saveStudySession(completedSession);
        
        // Update study profile with session history
        if (profile) {
          const updatedHistory = (profile.sessionHistory || []).concat({
            date: new Date().toISOString().slice(0, 10),
            duration: completedSession.actualDuration || completedSession.plannedDuration,
            completed: true,
            interruptionCount: completedSession.interruptionCount || 0,
            reflection,
          });
          
          // Keep only last 50 sessions in history
          const trimmedHistory = updatedHistory.slice(-50);
          
          await api.saveStudyProfile({
            ...profile,
            sessionHistory: trimmedHistory,
          });
        }
      } catch (e) {
        console.error("Failed to save completed session:", e);
      }
    }
    setShowReflection(false);
    setTimeout(() => exitSession(), 2000);
  }, [session, timeRemaining, notes, exitSession, profile]);

  // Format time as MM:SS
  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  };

  // Get current step
  const currentStep = task.steps?.find((s) => !s.done);

  // Command palette actions
  const commandActions = [
    { id: "notes", label: "Open notes", action: () => setNotesOpen(true), shortcut: "N" },
    { id: "materials", label: "Open materials", action: () => setMaterialsOpen(true), shortcut: "M" },
    { id: "ai", label: "Ask Otto", action: () => setAiOpen(true), shortcut: "A" },
    { id: "break", label: "Take a break", action: () => startBreak(), shortcut: "B" },
    { id: "pause", label: sessionState === "active" ? "Pause session" : "Resume session", action: () => sessionState === "active" ? pauseSession() : resumeSession(), shortcut: "Space" },
    { id: "fullscreen", label: isFullscreen ? "Exit fullscreen" : "Enter fullscreen", action: () => toggleFullscreen(), shortcut: "F11" },
    { id: "audio", label: audioPlaying ? "Stop audio" : "Play audio", action: () => toggleAudio(), shortcut: "" },
    { id: "focus-open", label: "Set focus: Open", action: () => setFocusLevel("open"), shortcut: "" },
    { id: "focus-balanced", label: "Set focus: Balanced", action: () => setFocusLevel("balanced"), shortcut: "" },
    { id: "focus-strict", label: "Set focus: Strict", action: () => setFocusLevel("strict"), shortcut: "" },
    { id: "exit", label: "Exit session", action: () => exitSession(), shortcut: "" },
  ];

  const filteredCommands = commandActions.filter((cmd) =>
    cmd.label.toLowerCase().includes(commandPaletteQuery.toLowerCase())
  );

  const executeCommand = useCallback((cmd: typeof commandActions[0]) => {
    cmd.action();
    setShowCommandPalette(false);
    setCommandPaletteQuery("");
  }, [pauseSession, resumeSession, startBreak, toggleFullscreen, toggleAudio, exitSession]);

  // AI chat functionality
  const sendAiMessage = useCallback(async (message: string) => {
    if (!message.trim()) return;
    
    setAiLoading(true);
    const newChat = [...aiChat, { role: "user" as const, text: message }];
    setAiChat(newChat);
    setAiInput("");
    
    try {
      const response = await api.chat(task.id, message);
      setAiChat([...newChat, { role: "assistant" as const, text: response.chat?.[response.chat.length - 1]?.text || "I couldn't process that request." }]);
    } catch (e) {
      setAiChat([...newChat, { role: "assistant" as const, text: "Sorry, something went wrong. Please try again." }]);
    } finally {
      setAiLoading(false);
    }
  }, [task.id, aiChat]);

  const handleAiOption = useCallback((option: string) => {
    const optionMessages: Record<string, string> = {
      explain: "Can you explain the current step in more detail?",
      hint: "Give me a hint for the current step without giving away the answer.",
      quiz: "Quiz me on the concepts in this task.",
      find: "Find relevant information in my materials for this task.",
      check: "Check my reasoning for the current step.",
      plan: "Help me plan how to approach this task.",
    };
    sendAiMessage(optionMessages[option] || option);
  }, [sendAiMessage]);

  // Render based on session state
  if (sessionState === "idle") {
    return <StudyModeStart task={task} onStart={startSession} profile={profile} />;
  }

  if (sessionState === "break") {
    return (
      <BreakMode
        timeRemaining={timeRemaining}
        formatTime={formatTime}
        onEndBreak={resumeSession}
        onExit={exitSession}
      />
    );
  }

  if (sessionState === "completed" && showReflection) {
    return (
      <SessionReflection
        onSubmit={submitReflection}
        onExit={exitSession}
      />
    );
  }

  return (
    <div className="study-mode-v2" style={{ display: 'flex', flexDirection: 'column', height: '100vh', width: '100vw', overflow: 'hidden' }}>
      {/* Top Bar (Layer 3) */}
      <div style={{ height: '40px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0 16px', borderBottom: '1px solid var(--border)', backgroundColor: 'var(--bg-card)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button onClick={() => exitSession()} style={{ background: 'none', border: 'none', cursor: 'pointer' }}>←</button>
          <span style={{ fontWeight: 500, fontSize: '14px' }}>{task.title}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div style={{ fontSize: '14px', fontFamily: 'monospace' }}>{formatTime(timeRemaining)}</div>
          <button onClick={() => exitSession()} style={{ background: 'none', border: 'none', cursor: 'pointer' }}>✕</button>
        </div>
      </div>

      {/* Main Workspace (Layer 1) */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {envState?.layout === 'writing' ? (
           <WritingWorkspace activeResource={materials.find(m => m.id === envState.activeResource) || null} />
        ) : envState?.layout === 'research' ? (
           <ResearchWorkspace 
             browserUrl={browserUrl} 
             notes={notes} 
             onBrowserUrlChange={setBrowserUrl} 
             onNotesChange={setNotes} 
             panes={envState.panes || {}} 
             setPanes={(p) => setEnvState({...envState, panes: p})} 
           />
        ) : envState?.layout === 'math' ? (
           <ProblemSolvingWorkspace 
             activeResource={materials.find(m => m.id === envState.activeResource) || null} 
             formulaSheet={materials.find(m => m.type === 'pdf') || null}
             panes={envState.panes || {}} 
           />
        ) : (
           <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
             <p>General Workspace</p>
           </div>
        )}
      </div>

      {/* Bottom Bar Tools (Layer 3) */}
      <div style={{ height: '50px', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '24px', borderTop: '1px solid var(--border)', backgroundColor: 'var(--bg-card)' }}>
        <button className="btn btn-ghost" onClick={() => setMaterialsOpen(!materialsOpen)}>Materials</button>
        <button className="btn btn-ghost" onClick={() => setNotesOpen(!notesOpen)}>Notes</button>
        <button className="btn btn-ghost" onClick={() => setShowSearch(!showSearch)}>Search</button>
        <button className="btn btn-ghost" onClick={() => setShowCommandPalette(true)}>Tools</button>
        <button className="btn btn-ghost" onClick={() => setShowAudioPanel(!showAudioPanel)}>Audio</button>
        <button className="btn btn-ghost" onClick={() => setAiOpen(!aiOpen)}>AI</button>
      </div>
      
      {/* Slide-in Panels (Layer 2) */}
      {materialsOpen && (
         <div style={{ position: 'absolute', top: '40px', bottom: '50px', right: 0, width: '300px', backgroundColor: 'var(--bg-card)', borderLeft: '1px solid var(--border)', zIndex: 10 }}>
           <MaterialsDrawer materials={materials} onClose={() => setMaterialsOpen(false)} task={task} />
         </div>
      )}
      {notesOpen && (
         <div style={{ position: 'absolute', top: '40px', bottom: '50px', right: materialsOpen ? '300px' : 0, width: '300px', backgroundColor: 'var(--bg-card)', borderLeft: '1px solid var(--border)', zIndex: 10 }}>
           <NotesPanel notes={notes} onChange={setNotes} onClose={() => setNotesOpen(false)} />
         </div>
      )}
      {aiOpen && (
         <div style={{ position: 'absolute', bottom: '60px', right: '16px', width: '350px', height: '500px', backgroundColor: 'var(--bg-card)', borderRadius: '8px', boxShadow: '0 4px 12px rgba(0,0,0,0.15)', zIndex: 20, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
           <AIAssistantPanel task={task} onClose={() => setAiOpen(false)} chat={aiChat} onSendMessage={sendAiMessage} input={aiInput} onInputChange={setAiInput} loading={aiLoading} onOptionClick={handleAiOption} />
         </div>
      )}
      {showSearch && (
         <div style={{ position: 'absolute', bottom: '50px', left: 0, right: 0, backgroundColor: 'var(--bg-card)', borderTop: '1px solid var(--border)', padding: '16px', zIndex: 15, display: 'flex', justifyContent: 'center' }}>
           <input type="text" autoFocus placeholder="Search the web or enter a URL" style={{ width: '600px', padding: '12px 16px', borderRadius: '24px', border: '1px solid var(--border)', outline: 'none', fontSize: '16px' }} onKeyPress={(e) => {
             if (e.key === 'Enter') {
               setBrowserUrl(e.currentTarget.value);
               if (envState) setEnvState({...envState, layout: 'research'});
               setShowSearch(false);
             }
           }} />
           <button style={{ marginLeft: '16px', background: 'none', border: 'none', fontSize: '24px', cursor: 'pointer' }} onClick={() => setShowSearch(false)}>✕</button>
         </div>
      )}
    </div>
  );
}

// Study Mode Start Screen
function StudyModeStart({
  task,
  onStart,
  profile,
}: {
  task: WebTask;
  onStart: (duration: number) => void;
  profile: StudyProfile | null;
}) {
  const recommendedDuration = profile?.preferredSessionLength || 45;
  const currentStep = task.steps?.find((s) => !s.done);

  return (
    <div className="study-mode-start">
      <h1>Study Mode</h1>
      <div className="start-task-info">
        <h2>{task.title}</h2>
        {currentStep && <p>{currentStep.text}</p>}
      </div>
      <div className="start-duration">
        <p>Recommended session: {recommendedDuration} minutes</p>
      </div>
      <button
        className="btn btn-primary btn-lg"
        onClick={() => onStart(recommendedDuration)}
      >
        Start
      </button>
    </div>
  );
}

// Break Mode Screen
function BreakMode({
  timeRemaining,
  formatTime,
  onEndBreak,
  onExit,
}: {
  timeRemaining: number;
  formatTime: (s: number) => string;
  onEndBreak: () => void;
  onExit: (reason?: string) => void;
}) {
  return (
    <div className="break-mode">
      <h1>BREAK</h1>
      <div className="break-timer">{formatTime(timeRemaining)}</div>
      <p>Get away from your screen.</p>
      <button className="btn btn-primary" onClick={onEndBreak}>
        End Break
      </button>
      <button className="btn btn-ghost" onClick={() => onExit("taking a break")}>
        Exit Study Mode
      </button>
    </div>
  );
}

// Session Reflection Screen
function SessionReflection({
  onSubmit,
  onExit,
}: {
  onSubmit: (r: "good" | "okay" | "difficult") => void;
  onExit: (reason?: string) => void;
}) {
  return (
    <div className="session-reflection">
      <h1>SESSION COMPLETE</h1>
      <p>How did that session go?</p>
      <div className="reflection-options">
        <button className="btn btn-primary" onClick={() => onSubmit("good")}>
          Good
        </button>
        <button className="btn btn-secondary" onClick={() => onSubmit("okay")}>
          Okay
        </button>
        <button className="btn btn-secondary" onClick={() => onSubmit("difficult")}>
          Difficult
        </button>
      </div>
      <button className="btn btn-ghost" onClick={() => onExit("finished")}>
        Skip
      </button>
    </div>
  );
}

// Notes Panel Component
function NotesPanel({
  notes,
  onChange,
  onClose,
}: {
  notes: string;
  onChange: (notes: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="notes-panel">
      <div className="drawer-header">
        <h3>Notes</h3>
        <button className="btn btn-ghost btn-sm" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="drawer-content">
        <textarea
          value={notes}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Take notes here..."
          className="notes-textarea"
        />
      </div>
    </div>
  );
}

// Materials Drawer
function MaterialsDrawer({
  materials,
  onClose,
  task,
}: {
  materials: StudyMaterial[];
  onClose: () => void;
  task: WebTask;
}) {
  return (
    <div className="materials-drawer materials-fullscreen">
      <div className="drawer-header">
        <h3>Materials</h3>
        <button className="btn btn-ghost btn-sm" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="drawer-content">
        {materials.length === 0 ? (
          <p className="muted">No materials found for this task.</p>
        ) : (
          <ul className="materials-list">
            {materials.map((m) => (
              <li key={m.id} className="material-item">
                <span className="material-type">{m.type}</span>
                {m.url ? (
                  <a href={m.url} target="_blank" rel="noopener noreferrer" className="material-link">
                    {m.label}
                  </a>
                ) : (
                  <span className="material-label">{m.label}</span>
                )}
                {m.source && <span className="material-source">{m.source}</span>}
              </li>
            ))}
          </ul>
        )}
        
        {/* Show task context and synthesis */}
        {task.context && (
          <div className="task-context">
            <h4>Context</h4>
            <p>{task.context}</p>
          </div>
        )}
        
        {task.synthesis && (
          <div className="task-synthesis">
            <h4>Summary</h4>
            <p>{task.synthesis}</p>
          </div>
        )}
      </div>
    </div>
  );
}

// AI Assistant Panel
function AIAssistantPanel({
  task,
  onClose,
  chat,
  onSendMessage,
  input,
  onInputChange,
  loading,
  onOptionClick,
}: {
  task: WebTask;
  onClose: () => void;
  chat: { role: "user" | "assistant"; text: string }[];
  onSendMessage: (msg: string) => void;
  input: string;
  onInputChange: (val: string) => void;
  loading: boolean;
  onOptionClick: (opt: string) => void;
}) {
  const options = [
    { id: "explain", label: "Explain" },
    { id: "hint", label: "Give me a hint" },
    { id: "quiz", label: "Quiz me" },
    { id: "find", label: "Find in my materials" },
    { id: "check", label: "Check my reasoning" },
    { id: "plan", label: "Help me plan" },
  ];

  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat]);

  return (
    <div className="ai-assistant-panel">
      <div className="drawer-header">
        <h3>Ask Otto</h3>
        <button className="btn btn-ghost btn-sm" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="drawer-content">
        <div className="ai-options">
          {options.map((opt) => (
            <button
              key={opt.id}
              className="btn btn-ghost"
              onClick={() => onOptionClick(opt.id)}
            >
              {opt.label}
            </button>
          ))}
        </div>
        
        <div className="ai-chat">
          {chat.map((msg, idx) => (
            <div key={idx} className={`chat-message ${msg.role}`}>
              <div className="message-content">{msg.text}</div>
            </div>
          ))}
          {loading && (
            <div className="chat-message assistant">
              <div className="message-content">...</div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
        
        <div className="ai-input">
          <input
            type="text"
            value={input}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyPress={(e) => e.key === "Enter" && onSendMessage(input)}
            placeholder="Ask Otto anything..."
            disabled={loading}
          />
          <button
            className="btn btn-primary btn-sm"
            onClick={() => onSendMessage(input)}
            disabled={loading || !input.trim()}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
