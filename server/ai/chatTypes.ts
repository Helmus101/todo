
import type { TaskNote, TaskFlashcards, TaskQuiz, TaskProblem, BoardEntry, TaskObjective } from "../../shared/types.ts";
import type { AgentTools } from "../integrations.ts";
import { type BoardEvent } from "../boardEvents.ts";
import { type TutorPlan, type TutorPolicy } from "../tutorBrain.ts";
import type { TutorSessionStateShape } from "../../shared/agentTypes.ts";
import { AuditEvent } from "./context.ts";


/** What a chat turn knows about its task. */
export interface ChatTask {
  title: string;
  why: string;
  context?: string;
  steps?: { text: string; done?: boolean; substeps?: { text: string; done: boolean }[] }[];
  source?: string;
  sourceDetail?: string;
  sourceSubject?: string;
  sourceDue?: string;
  flashcards?: TaskFlashcards[];
  quizzes?: TaskQuiz[];
}

export type ChatHistory = { role: "user" | "assistant"; text: string }[];

/** Per-turn options for chatAboutTask (tutor mode, board state, voice, materials, …). */
export interface ChatOptions {
  schoolRecord?: string;
  stepIndex?: number;
  materials?: { label: string; text: string }[];
  extras?: AgentTools;
  styleArm?: string;
  growthTrend?: "up";
  subjectSignal?: { correctRate: number; attempts: number; trend?: "up" | "down" | "flat" };
  voiceMode?: boolean;
  spoken?: { alternatives: string[] };
  stepVerdict?: { gap: string; given: string; verdict: "correct" | "incorrect" };
  canvasMode?: boolean;
  recentJournal?: { date: string; text: string; subjects?: string[] }[];
  journalMeta?: { total: number; subjects: Record<string, number> };
  primer?: boolean;
  currentBoard?: BoardEntry[];
  currentProblems?: TaskProblem[];
  currentObjectives?: TaskObjective[];
  notNeeded?: string[];
  repair?: string;
  moveLine?: string;
  opening?: { role: string; text: string }[];
  boardEvents?: BoardEvent[];
  sessionState?: TutorSessionStateShape;
  policy?: TutorPolicy;
}

/** What `chatAboutTask` returns: the spoken reply, plus any artifacts the tutor made this turn (empty
 *  arrays, never undefined — the route accumulates these straight onto the task). */
export interface ChatResult {
  reply: string;
  notes: TaskNote[];
  flashcards: TaskFlashcards[];
  quizzes: TaskQuiz[];
  problems: TaskProblem[];
  board: BoardEntry[];
  boardCleared?: boolean;
  /** Set ONLY when SET_OBJECTIVES was called this turn — the FULL replacement list, not a delta (see the
   *  tool's own contract). Undefined (not an empty array) when Otto didn't touch objectives this turn, so
   *  the route/client can tell "no change" apart from "cleared the list", which never happens in practice. */
  objectives?: TaskObjective[];
  audit: AuditEvent[];
  tokens: { in: number; out: number; cachedIn?: number };
  /** Set when CHAT_DOES_WORK tripped this turn (reply text or a note body) — lets the client tag the
   *  exact chat bubble where the "won't do your graded work" boundary held, instead of that only being
   *  visible in the per-task Activity log. */
  guardrailTripped: boolean;
  /** Set ONLY when `reply` is the honest "Otto couldn't reply just now — try again in a moment" fallback
   *  because the request genuinely failed (DeepSeek error, or the model came back with empty content) —
   *  never for a normal short reply that happens to be brief. Lets the client show this as a real error
   *  ("Otto couldn't reply — try again") instead of rendering it as an in-character chat bubble, which used
   *  to make an actual outage (bad API key, DeepSeek down) look exactly like Otto just being unhelpful. */
  error?: boolean;
  /** Tutor only: the hidden plan the model wrote this turn (tutorBrain.ts) — never shown to the student. */
  plan?: TutorPlan;
  /** Set when the app vetoed the model's first plan against the tutor policy and it re-planned. */
  planCorrection?: { from: TutorPlan["action"]; reason: string };
}
