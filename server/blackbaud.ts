/**
 * Blackbaud (school Education Management — assignments/grades, the "Pronote-equivalent" many international
 * schools use) — MOCK ONLY for now, deliberately, same posture as plaid.ts's sandbox-only stance but for a
 * more fundamental reason: this isn't a self-service developer sandbox Otto can just sign up for. Blackbaud's
 * real SKY API needs (1) a registered developer app with an approved subscription key, and (2) for most
 * education-data endpoints, the SCHOOL's own Blackbaud admin explicitly enabling API access for that specific
 * app — a single student can't authorize this the way they can type their own Pronote username/password.
 * Neither exists yet, so there is no real-credential code path here at all (unlike plaid.ts, which at least
 * has a working sandbox mode against Plaid's real API) — only the mock path, so the whole flow (connect →
 * assignments → proactive tasks) is demoable and the task-pipeline wiring (discover.ts's blackbaudToItems)
 * is real and ready, without pretending there's a working integration to a real school today.
 *
 * When real SKY API access is available: this file is where the actual OAuth (school-specific authorization
 * code flow) + REST calls against Blackbaud's Education Management endpoints would go, following the exact
 * same shape as plaid.ts's createLinkToken/exchangePublicToken/disconnectPlaid — the store.ts encrypted-token
 * plumbing (StoredBlackbaud) is already wired for it.
 */
import { loadState, saveState, type StoredBlackbaud } from "./store.ts";

const MOCK_ENABLED = process.env.BLACKBAUD_MOCK === "1";
const MOCK_ACCESS_TOKEN = "mock-access-token";

export function blackbaudConfigured(): boolean {
  // Always false outside mock mode — see the file-level comment for why there's no real credential path yet.
  return MOCK_ENABLED;
}

export async function blackbaudConnected(email: string): Promise<{ connected: boolean; schoolName?: string }> {
  const { blackbaud } = await loadState(email);
  return blackbaud ? { connected: true, schoolName: blackbaud.schoolName } : { connected: false };
}

/** The only connect path that exists right now — see the file-level comment. Mirrors plaid.ts's
 *  connectMock/pronote.ts's mock-URL connect: only does anything when BLACKBAUD_MOCK=1, otherwise a clear
 *  refusal so this can never accidentally fake a connection in a real deployment. */
export async function connectMock(email: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!MOCK_ENABLED) return { ok: false, error: "Blackbaud isn't available yet — this integration needs a registered SKY API subscription key and your school's Blackbaud admin to enable API access, neither of which exists yet. Demo mode isn't enabled on this server either." };
  const state = await loadState(email);
  const blackbaud: StoredBlackbaud = { accessToken: MOCK_ACCESS_TOKEN, schoolName: "Lycée Démo", connectedAt: new Date().toISOString() };
  await saveState(email, { ...state, blackbaud });
  return { ok: true };
}

export async function disconnectBlackbaud(email: string): Promise<void> {
  const state = await loadState(email);
  await saveState(email, { ...state, blackbaud: undefined });
}

export interface BlackbaudAssignment {
  id: string;
  title: string;
  subject?: string;
  dueDate?: string; // ISO date
  description?: string;
}

// One overdue-feeling assignment (due tomorrow) and one further out — same "one weak, one strong"
// demonstration posture as pronote.ts's mockGrades / plaid.ts's mockSnapshot, so blackbaudToItems
// (discover.ts) has something real to turn into a task candidate when demoing this end to end.
function mockAssignments(): BlackbaudAssignment[] {
  const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
  return [
    { id: "mock-bb-1", title: "Lab report — cellular respiration", subject: "Biology", dueDate: inDays(1), description: "Write up the lab from Tuesday's practical, 2 pages, include your raw data table." },
    { id: "mock-bb-2", title: "Problem set 4 — integration techniques", subject: "Math HL", dueDate: inDays(5) },
  ];
}

/** Read-only assignment list — what discover.ts's blackbaudToItems reasons over for proactive task
 *  candidates, same role as pronoteHomework/plaidSnapshot. Best-effort: never throws into the discovery
 *  pipeline. Mock-only right now (see file-level comment) — returns [] for a non-mock connection, since
 *  none can currently exist. */
export async function blackbaudAssignments(email: string): Promise<BlackbaudAssignment[]> {
  const { blackbaud } = await loadState(email);
  if (!blackbaud) return [];
  if (blackbaud.accessToken === MOCK_ACCESS_TOKEN) return mockAssignments();
  return []; // no real SKY API client exists yet — see file-level comment
}
