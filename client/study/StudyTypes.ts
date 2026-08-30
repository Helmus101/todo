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
  | "flashcard";

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
  type: "pdf" | "video" | "document" | "link" | "image" | "note";
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
  audioType: string;
  audioVolume: number;
  audioPlaying: boolean;
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
