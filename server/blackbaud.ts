/**
 * Blackbaud (school Education Management — assignments/grades, the "Pronote-equivalent" many international
 * schools use). Real OAuth authorization-code flow is implemented below — but it needs THREE things to
 * actually work, not just a subscription key: BLACKBAUD_SUBSCRIPTION_KEY identifies which app is calling
 * SKY API, it does NOT authorize access to anyone's data; that needs a separate OAuth "Application"
 * registered in the Blackbaud developer portal, giving BLACKBAUD_CLIENT_ID + BLACKBAUD_CLIENT_SECRET. Until
 * all three env vars are set, realCredentialsConfigured() stays false and only BLACKBAUD_MOCK works —
 * same "don't pretend it's ready" posture as plaid.ts's sandbox-only stance, just for a different reason
 * (missing app registration, not missing sandbox access).
 *
 * OAuth endpoints/flow verified against Blackbaud's own documentation and community references (not hand-
 * guessed): authorize at https://app.blackbaud.com/oauth/authorize, exchange/refresh at
 * https://oauth2.sky.blackbaud.com/token (standard OAuth2 authorization-code shape), and every data call
 * needs BOTH `Authorization: Bearer <token>` AND a `Bb-Api-Subscription-Key` header. Access tokens expire
 * in ~60 minutes with a refresh_token to renew.
 *
 * The one piece that ISN'T independently verified against Blackbaud's official reference: the exact
 * assignments endpoint path/params in blackbaudAssignments below (built from Blackbaud's documented "GET
 * Academics Assignments for a student" resource under the School API, which requires a student_id and an
 * OAuth authorization from the Parent or Student role). Treat that one endpoint as a best-effort starting
 * point — verify it against the live SKY API console (developer.blackbaud.com) the first time a real
 * access token exists to test with, before relying on it.
 */
import { loadState, saveState, type StoredBlackbaud } from "./store.ts";

const MOCK_ENABLED = process.env.BLACKBAUD_MOCK === "1";
const MOCK_ACCESS_TOKEN = "mock-access-token";

const SUBSCRIPTION_KEY = process.env.BLACKBAUD_SUBSCRIPTION_KEY;
const CLIENT_ID = process.env.BLACKBAUD_CLIENT_ID;
const CLIENT_SECRET = process.env.BLACKBAUD_CLIENT_SECRET;
// Same PUBLIC_URL-with-localhost-fallback convention every other OAuth callback in this app uses
// (server/index.ts's Google callback, server/pronote.ts's reconnect links).
const REDIRECT_URI = process.env.BLACKBAUD_REDIRECT_URI
  || `${process.env.PUBLIC_URL || "http://localhost:5273"}/api/integrations/blackbaud/callback`;

const AUTHORIZE_URL = "https://app.blackbaud.com/oauth/authorize";
const TOKEN_URL = "https://oauth2.sky.blackbaud.com/token";
const API_BASE = "https://api.sky.blackbaud.com";

function realCredentialsConfigured(): boolean {
  return !!(SUBSCRIPTION_KEY && CLIENT_ID && CLIENT_SECRET);
}

export function blackbaudConfigured(): boolean {
  return MOCK_ENABLED || realCredentialsConfigured();
}

/** Whether a REAL connection (not just mock) is even reachable right now — used by the Settings tile to
 *  show "connect for real" vs. "demo only" instead of a single generic on/off. */
export function blackbaudRealAuthAvailable(): boolean {
  return realCredentialsConfigured();
}

export async function blackbaudConnected(email: string): Promise<{ connected: boolean; schoolName?: string }> {
  const { blackbaud } = await loadState(email);
  return blackbaud ? { connected: true, schoolName: blackbaud.schoolName } : { connected: false };
}

/** Step 1 of the real flow — the URL to send the student's browser to. `state` is a CSRF nonce the caller
 *  must generate, store against the session, and verify on callback (same pattern as any OAuth integration
 *  — never skip this, it's what stops a forged callback from linking an attacker's Blackbaud account to a
 *  victim's Otto session). Throws if the OAuth application isn't configured — callers must check
 *  blackbaudRealAuthAvailable() first and offer mock mode instead when it's false. */
export function getAuthUrl(state: string): string {
  if (!realCredentialsConfigured()) throw new Error("Blackbaud OAuth isn't configured — set BLACKBAUD_CLIENT_ID and BLACKBAUD_CLIENT_SECRET.");
  const params = new URLSearchParams({ client_id: CLIENT_ID!, response_type: "code", redirect_uri: REDIRECT_URI, state });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

interface TokenResponse { access_token: string; refresh_token?: string; expires_in: number; }

async function fetchToken(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID!, client_secret: CLIENT_SECRET!, ...body }).toString(),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Blackbaud token request failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  return res.json();
}

/** Step 2 — the authorization code the callback route receives gets exchanged here for real tokens. */
export async function exchangeCode(email: string, code: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!realCredentialsConfigured()) return { ok: false, error: "Blackbaud OAuth isn't configured on this server yet." };
  try {
    const tok = await fetchToken({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI });
    const state = await loadState(email);
    const blackbaud: StoredBlackbaud = {
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token,
      expiresAt: Date.now() + tok.expires_in * 1000,
      connectedAt: new Date().toISOString(),
    };
    await saveState(email, { ...state, blackbaud });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || "Couldn't connect to Blackbaud." };
  }
}

/** Refreshes the stored access token when it's expired (or close to it), silently — same "the student
 *  should never have to notice or act on this" posture as pronote.ts's own token-refresh handling. Returns
 *  null when there's no real connection to refresh (mock, or none at all) or the refresh itself fails —
 *  callers treat that as "no usable token," never throw into the discovery pipeline. */
async function ensureFreshToken(email: string): Promise<string | null> {
  const { blackbaud } = await loadState(email);
  if (!blackbaud || blackbaud.accessToken === MOCK_ACCESS_TOKEN) return null;
  const SAFETY_MARGIN_MS = 60_000;
  if (blackbaud.expiresAt && blackbaud.expiresAt - SAFETY_MARGIN_MS > Date.now()) return blackbaud.accessToken;
  if (!blackbaud.refreshToken) return null;
  try {
    const tok = await fetchToken({ grant_type: "refresh_token", refresh_token: blackbaud.refreshToken });
    const state = await loadState(email);
    const updated: StoredBlackbaud = {
      ...blackbaud,
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token || blackbaud.refreshToken,
      expiresAt: Date.now() + tok.expires_in * 1000,
    };
    await saveState(email, { ...state, blackbaud: updated });
    return updated.accessToken;
  } catch (e) {
    console.warn("[blackbaud] token refresh failed:", (e as any)?.message || e);
    return null;
  }
}

/** The only connect path that works with zero real credentials — see the file-level comment. Mirrors
 *  plaid.ts's connectMock/pronote.ts's mock-URL connect: only does anything when BLACKBAUD_MOCK=1. */
export async function connectMock(email: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!MOCK_ENABLED) return { ok: false, error: "Demo mode isn't enabled on this server." };
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
// demonstration posture as pronote.ts's mockGrades / plaid.ts's mockSnapshot.
function mockAssignments(): BlackbaudAssignment[] {
  const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
  return [
    { id: "mock-bb-1", title: "Lab report — cellular respiration", subject: "Biology", dueDate: inDays(1), description: "Write up the lab from Tuesday's practical, 2 pages, include your raw data table." },
    { id: "mock-bb-2", title: "Problem set 4 — integration techniques", subject: "Math HL", dueDate: inDays(5) },
  ];
}

/** Read-only assignment list — what discover.ts's blackbaudToItems reasons over for proactive task
 *  candidates, same role as pronoteHomework/plaidSnapshot. Best-effort: never throws into the discovery
 *  pipeline. Real-mode call shape is best-effort/unverified — see the file-level comment. */
export async function blackbaudAssignments(email: string): Promise<BlackbaudAssignment[]> {
  const { blackbaud } = await loadState(email);
  if (!blackbaud) return [];
  if (blackbaud.accessToken === MOCK_ACCESS_TOKEN) return mockAssignments();
  const token = await ensureFreshToken(email);
  if (!token) return [];
  try {
    // "GET Academics Assignments for a student" — needs the Blackbaud-internal student_id, which for a
    // student's OWN OAuth authorization Blackbaud resolves via "me" per their docs; NOT independently
    // verified end to end (no real access token has exercised this yet — see the file-level comment).
    const res = await fetch(`${API_BASE}/school/v1/academics/assignments?student_id=me`, {
      headers: { Authorization: `Bearer ${token}`, "Bb-Api-Subscription-Key": SUBSCRIPTION_KEY! },
    });
    if (!res.ok) { console.warn(`[blackbaud] assignments fetch failed (${res.status})`); return []; }
    const data = await res.json();
    const rows = Array.isArray(data?.value) ? data.value : Array.isArray(data) ? data : [];
    return rows.map((a: any): BlackbaudAssignment => ({
      id: String(a.id ?? a.assignment_id ?? crypto.randomUUID()),
      title: String(a.name ?? a.title ?? "Assignment"),
      subject: a.course_name ?? a.section_name ?? undefined,
      dueDate: a.due_date ?? a.assigned_date ?? undefined,
      description: a.description ?? undefined,
    }));
  } catch (e: any) {
    console.warn("[blackbaud] assignments fetch failed:", e?.message || e);
    return [];
  }
}
