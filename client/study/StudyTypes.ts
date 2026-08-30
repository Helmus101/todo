// Study Mode — Local Types
// These live client-side only; they extend shared/types.ts

export type ArtifactType =
  | "notes"
  | "scratchpad"
  | "whiteboard"
  | "calculator"
  | "desmos"
  | "dictionary"
  | "sticky"
  | "pdf"
  | "image"
  | "video"        // YouTube / embeddable video
  | "document"     // Google Doc / generic document
  | "flashcard"
  | "quiz";

export type DockSide = "none" | "left" | "right" | "fullscreen";

export interface ArtifactState {
  id: string;
  type: ArtifactType;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  minimized: boolean;
  maximized: boolean;
  dockSide: DockSide;
  contentState: Record<string, unknown>; // type-specific inner state
  source?: string; // URL or material ID
  sourceLabel?: string;
  taskId: string;
  environmentId: string;
}

export type WorkspaceTemplate =
  | "WRITING"
  | "READING"
  | "PROBLEM_SOLVING"
  | "REVISION"
  | "RESEARCH"
  | "PROJECT"
  | "STANDARD";

export interface StudyMaterial {
  id: string;
  label: string;
  type: "pdf" | "video" | "document" | "link" | "image" | "note" | "flashcard" | "quiz";
  url?: string;
  file?: File;           // not persisted in IndexedDB, use objectUrl
  objectUrl?: string;    // blob URL after upload
  source?: string;       // "upload" | "youtube" | "google" | "link"
  size?: number;
  text?: string;
}

export interface StudyEnvironment {
  id: string;
  taskId: string;
  template: WorkspaceTemplate;
  artifacts: ArtifactState[];
  notes: string;
  scratchpad: string;
  audioType: string; // "silence" | "brown" | "pink" | "white" | "custom"
  audioVolume: number;
  audioPlaying: boolean;
  /** Set when audioType is "custom" — the student's own uploaded track, stored as a Blob in IndexedDB
   *  (StudyDB.ts's "files" store) and rebuilt into a fresh object URL each load. */
  customAudioFileId?: string;
  customAudioName?: string;
  /** Set when audioType is "spotify" — a pasted playlist/album/track link, embedded via Spotify's own
   *  official iframe widget (open.spotify.com/embed/...). Spotify controls playback itself (including its
   *  own play/pause and volume) — our audioVolume/audioPlaying don't apply to this track. */
  spotifyEmbedUrl?: string;
  /** The student's own desk background image — stored as a Blob in IndexedDB (StudyDB.ts's "files" store,
   *  same one customAudioFileId uses) and rebuilt into a fresh object URL each load. Unset = the default
   *  dot-grid desk background. */
  backgroundImageFileId?: string;
  backgroundImageName?: string;
  /** Pomodoro cycling — when enabled, work/break alternate automatically instead of the student having to
   *  remember to hit Break. Chosen once at Start (StudySetup) and persisted so it survives a reload. */
  pomodoroEnabled?: boolean;
  pomodoroWorkMinutes?: number;  // default 25
  pomodoroBreakMinutes?: number; // default 5
  pomodoroCycles?: number;       // completed work→break cycles this session, for the "Cycle N" display
  currentSubtaskIndex: number;
  timerElapsed: number;   // seconds elapsed
  sessionStatus: "idle" | "active" | "paused" | "break" | "completed" | "ended";
  lastSavedAt: string;
  materials: StudyMaterial[];
}

export interface SessionLog {
  id: string;
  taskId: string;
  environmentId: string;
  startedAt: string;
  endedAt?: string;
  elapsedSeconds: number;
  breakSeconds: number;
  completedSubtasks: number[];
  submittedWork: Array<{
    subtaskIndex: number;
    status: "completed" | "partial" | "stuck";
    note: string;
    at: string;
  }>;
}

export type SessionStatus = "idle" | "active" | "paused" | "break" | "completed" | "ended";
