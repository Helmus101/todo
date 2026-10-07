// Tutor session summaries — kept ENTIRELY in this browser (same pattern as localChatBoard.ts: the
// content of what was said/written is never STORED in the cloud — it lives here, and the session's own chat
// and board are the only copies that live with the server task). Each time a student ends a tutor session,
// a short summary of what was accomplished is derived from the board entries + chat and stored here so
// the tutor can "remember" past sessions and the student can review what they've done. The one path out is
// sessionMemoryForPrompt below: a compact recap of the last few sessions rides along with the opening-line
// request so Otto's first line can be grounded in what the student actually did — used for that prompt
// only, never written back to the server.
import type { BoardEntry, WebTask } from "../../shared/types.ts";

export interface TutorSessionSummary {
  id: string;
  taskId: string;
  startTime: string;   // ISO
  endTime: string;      // ISO
  messageCount: number;
  boardEntries: string[];   // flat text of each board entry — the raw material sessionTopic/sessionMemoryForPrompt read from
  // The FULL board (kind labels, diagrams, equations — everything BoardArtifact needs to actually re-render
  // it), not just the flattened text above. Added so ending a session doesn't reduce a worked-through
  // diagram or written-out equation down to a caption in a bullet list — the student can reopen the real
  // board exactly as it looked when the session ended. Optional or absent for a session saved before this
  // field existed (older localStorage entries) — history views must degrade to the text-only boardEntries.
  board?: BoardEntry[];
  // The full chat history (all messages with role and text) so the conversation can be reviewed later
  chat?: NonNullable<WebTask["chat"]>;
  summary: string;          // a short auto-generated recap
  subject?: string;         // the subject selected when starting the session
  // Final tally of task.objectives at session end (SET_OBJECTIVES tool, see shared/types.ts) — the
  // live "Today's focus" checklist already tracks these during the session; this just persists the
  // final counts so the Past-sessions list can show "what did I cover" at a glance. Both undefined for
  // a session with no objectives set at all (not every session gets them), not a fabricated 0/0.
  objectivesCompleted?: number;
  objectivesTotal?: number;
}

const BASE_KEY = "otto-tutor-sessions";
const CAP = 50;

function getKey(userId: string | null): string {
  return userId ? `${BASE_KEY}:${userId}` : BASE_KEY;
}

function readAll(userId: string | null): TutorSessionSummary[] {
  try {
    const raw = localStorage.getItem(getKey(userId));
    if (raw) return JSON.parse(raw) as TutorSessionSummary[];
  } catch { /* corrupt/unavailable */ }
  return [];
}

function writeAll(list: TutorSessionSummary[], userId: string | null): void {
  try { localStorage.setItem(getKey(userId), JSON.stringify(list.slice(-CAP))); } catch { /* storage full */ }
}

/** Build a short recap string from the board + chat of a just-ended session. */
export function buildSessionSummary(board: BoardEntry[], chat: NonNullable<WebTask["chat"]>): string {
  const boardTexts = board.map((b) => String(b?.text ?? "").trim()).filter(Boolean);
  const parts: string[] = [];
  if (boardTexts.length) {
    // Preserve line breaks and structure instead of flattening with " · "
    // Take first 6 entries to keep it compact but readable
    parts.push(boardTexts.slice(0, 6).join("\n"));
  }
  const userMsgs = chat.filter((m) => m.role === "user").length;
  if (userMsgs) parts.push(`${userMsgs} message${userMsgs > 1 ? "s" : ""}`);
  return parts.join(" — ") || "Session completed";
}

/** Save a finished session's summary. */
export function saveTutorSession(summary: TutorSessionSummary, userId: string | null = null): void {
  const list = readAll(userId);
  list.push(summary);
  writeAll(list, userId);
}

/** All past session summaries, newest first. */
export function getTutorSessions(userId: string | null = null): TutorSessionSummary[] {
  return readAll(userId).reverse();
}

/** Board lines the tutor writes as a HEADING rather than as content — a kind label, a caption, or an empty
 *  invitation ("The equation to work with", "Today's focus", "Let's get started"). These read as memory when
 *  quoted back ("last time we worked on: 'The equation to work with'") but name nothing the student studied,
 *  so the topic picker skips them. Everything else on a board IS real content. */
const CAPTION_RE = /^(the equation to work with|equation to work with|today'?s focus|your reasoning|how you got there|work to do|let'?s get started|to work on|the problem|formula|definition|figure|graph|problem|note|instruction|insight|outline|objectif du jour|ton raisonnement|l'?équation à traiter|formule|définition|figure|graphique|problème|consigne)$/i;
/** The best HUMAN topic for a past session: the most content-like line its board actually holds (falling
 *  back to the stored recap), with markdown/LaTeX noise and length trimmed. "" when there is genuinely
 *  nothing real to name — the caller must then NOT claim to remember anything. Exported for tests. */
export function sessionTopic(s: TutorSessionSummary): string {
  const clean = (raw: string) => String(raw || "")
    .replace(/^\s*(?:[-•*]|\d+[.)])\s*/, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/\s*\n+\s*/g, " ").replace(/\s{2,}/g, " ").trim();
  const candidates = [...(s.boardEntries || []), ...(s.summary || "").split(/\n| — /)]
    .map(clean)
    .filter((t) => t && t.length >= 6 && !CAPTION_RE.test(t) && t !== "Session completed");
  // Prefer a line with actual substance in it: a digit or an operator usually means real work (an equation, a
  // value, a derivation) rather than a spoken aside, and those are what a student recognizes as "what we did".
  const rich = candidates.find((t) => /[=+×÷^√<>]|\d/.test(t));
  const pick = rich || candidates[0] || clean((s.summary || "").split(" — ")[0]);
  if (!pick || CAPTION_RE.test(pick) || pick === "Session completed") return "";
  return pick.length > 90 ? pick.slice(0, 88).trimEnd() + "…" : pick;
}
/** When a past session happened, in the student's own language and only as precisely as it's actually known
 *  ("yesterday", "3 days ago", "last week") — "" for an unknown/unparseable stamp, never a guess. Exported
 *  for tests. */
export function relativeWhen(iso: string | undefined, now: number, lang: "fr" | "en"): string {
  const t = Date.parse(String(iso || ""));
  if (!Number.isFinite(t)) return "";
  const days = Math.floor((now - t) / 86_400_000);
  if (days <= 0) return lang === "en" ? "earlier today" : "tout à l'heure";
  if (days === 1) return lang === "en" ? "yesterday" : "hier";
  if (days < 7) return lang === "en" ? `${days} days ago` : `il y a ${days} jours`;
  if (days < 14) return lang === "en" ? "last week" : "la semaine dernière";
  if (days < 60) return lang === "en" ? `${Math.round(days / 7)} weeks ago` : `il y a ${Math.round(days / 7)} semaines`;
  return lang === "en" ? "a while ago" : "il y a longtemps";
}

/** The REAL memory sent up for Otto's opening line (see tutorOpener in server/claude.ts): the actual board
 *  lines and the student's own questions from their most recent sessions, newest first, this subject's
 *  sessions ahead of the rest. This is the only place the browser's session history reaches the server, and
 *  it goes up purely to be grounded in — nothing here is stored server-side. Sessions with nothing real to
 *  name are dropped rather than sent as a hollow "session completed" row, so the opener can't invent a
 *  topic out of an empty one. Exported for tests. */
export function sessionMemoryForPrompt(
  sessions: TutorSessionSummary[],
  subject: string | undefined,
  now: number,
  lang: "fr" | "en",
): { when: string; subject?: string; lines: string[]; asked: string[] }[] {
  const score = (s: TutorSessionSummary) => (subject && s.subject === subject ? 0 : 1);
  const ordered = [...sessions].sort((a, b) => score(a) - score(b) || String(b.endTime).localeCompare(String(a.endTime)));
  const out: { when: string; subject?: string; lines: string[]; asked: string[] }[] = [];
  for (const s of ordered) {
    const topic = sessionTopic(s);
    if (!topic) continue;
    // The topic leads the lines so the model sees what the student would recognize first; the remaining
    // board lines carry the detail (the actual equation, the values) a retrieval question can build on.
    const rest = (s.boardEntries || [""]).slice(0, 6).map((t) => t.replace(/\s*\n+\s*/g, " · ").trim()).filter((t) => t && t !== topic);
    const asked = (s.chat || []).filter((m) => m.role === "user").slice(0, 3).map((m) => String(m.text || "").replace(/\s*\n+\s*/g, " ").trim()).filter(Boolean);
    out.push({
      when: relativeWhen(s.endTime, now, lang),
      ...(s.subject ? { subject: s.subject } : {}),
      lines: [`${topic}`, ...rest].slice(0, 6).map((l) => (l.length > 200 ? l.slice(0, 198).trimEnd() + "…" : l)),
      asked: asked.map((q) => (q.length > 200 ? q.slice(0, 198).trimEnd() + "…" : q)),
    });
    if (out.length >= 3) break;
  }
  return out;
}

/** Called on signout — same scoping rationale as clearLocalChatBoard. */
export function clearTutorSessions(userId: string | null): void {
  try { localStorage.removeItem(getKey(userId)); } catch { /* ignore */ }
}
