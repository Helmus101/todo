import type { WebTask, ConnectionStatus, Profile } from "../shared/types.ts";
import { emptyProfile, normalizeProfile } from "../shared/types.ts";

export interface IntegrationItem { key: string; name: string; blurb: string; category: string; logo: string; connected: boolean; accounts?: ConnectedAccount[]; }
export interface ConnectedAccount { id: string; email?: string; toolkit: string; status: string; }
export interface IntegrationsResp { ready: boolean; items: IntegrationItem[]; }
export interface ChatSource { title: string; url: string; }
export interface ChatMsg { role: "user" | "assistant"; content: string; }
export interface ChatReply { reply: string; sources: ChatSource[]; via: string; }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch() that survives a brief backend outage — e.g. the `tsx watch` dev server restarting on a file
 * change drops port 8788 for ~2s, during which the Vite proxy answers with ECONNREFUSED. We retry through
 * that window so the user never sees a "proxy error" / failed request; the call just lands once the server
 * is back. Two transient cases are retried:
 *   1. fetch REJECTS (connection refused → no response reached us). The request never hit the server, so
 *      retrying is safe even for mutations (run/generate/send) — nothing executed.
 *   2. fetch RESOLVES with a 5xx whose body is NOT JSON — that's the proxy's own error page, not a real
 *      server response. A genuine server error returns JSON {error} (content-type json) and is NOT retried.
 */
async function req(url: string, init?: RequestInit, retries = 6): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url, init);
      if (r.status >= 500 && attempt < retries) {
        const ct = r.headers.get("content-type") || "";
        if (!ct.includes("application/json")) { await sleep(500 + attempt * 250); continue; } // proxy error page → retry
      }
      return r;
    } catch (e) {
      if (attempt < retries) { await sleep(500 + attempt * 250); continue; } // connection refused → server restarting
      throw e;
    }
  }
}

const j = async (r: Response) => {
  if (!r.ok && r.status !== 401) {
    const err: any = new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    err.status = r.status; // callers need this to tell "already running elsewhere" (409) from a real failure
    throw err;
  }
  return r.json();
};
const post = (url: string, body?: unknown) =>
  req(url, { method: "POST", headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined }).then(j);
// Auth posts surface the server's error message instead of throwing, so the form can show it.
const authPost = (url: string, body: unknown): Promise<{ ok: boolean; error?: string }> =>
  req(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    .then(async (r) => ({ ok: r.ok, ...(await r.json().catch(() => ({}))) }));

export const api = {
  status: (): Promise<ConnectionStatus> => req("/api/status").then(j),
  signup: (email: string, password: string) => authPost("/api/auth/signup", { email, password }),
  login: (email: string, password: string) => authPost("/api/auth/login", { email, password }),
  integrations: (): Promise<IntegrationsResp> => req("/api/integrations").then(j),
  integrationAccounts: (app: string): Promise<{ accounts: ConnectedAccount[] }> => req(`/api/integrations/${app}/accounts`).then(j),
  disconnectIntegration: (app: string): Promise<{ ok: boolean }> => post(`/api/integrations/${app}/disconnect`),
  disconnectAccount: (app: string, accountId: string): Promise<{ ok: boolean }> => post(`/api/integrations/${app}/disconnect/${accountId}`),
  tasks: (): Promise<WebTask[]> => req("/api/tasks").then(j),
  generate: (force = false): Promise<WebTask[]> => post("/api/tasks/generate", force ? { force: true } : undefined),
  add: (title: string): Promise<WebTask[]> => post("/api/tasks", { title }),
  run: (id: string): Promise<WebTask> => post(`/api/tasks/${id}/run`),
  revise: (id: string, note: string): Promise<WebTask> => post(`/api/tasks/${id}/revise`, { note }),
  confirm: (id: string): Promise<WebTask[]> => post(`/api/tasks/${id}/confirm`),
  reject: (id: string): Promise<WebTask[]> => post(`/api/tasks/${id}/reject`),
  dismiss: (id: string): Promise<WebTask[]> => post(`/api/tasks/${id}/dismiss`),
  runStep: (id: string, index: number, answer?: string): Promise<WebTask> => post(`/api/tasks/${id}/step/${index}/run`, answer ? { answer } : undefined),
  stepDone: (id: string, index: number, done = true, result?: string): Promise<WebTask[]> => post(`/api/tasks/${id}/step/${index}/done`, { done, result }),
  sendDraft: (id: string, index: number): Promise<WebTask> => post(`/api/tasks/${id}/send/${index}`),
  chat: (messages: ChatMsg[]): Promise<ChatReply> => post("/api/chat", { messages }),
  // Profile responses are normalized to a valid shape (and fall back to empty on a 401/odd body) so the
  // editor never receives a non-Profile object and crashes.
  profile: (): Promise<Profile> => req("/api/profile").then(j).then(normalizeProfile).catch(() => emptyProfile()),
  setProfile: (category: string, value: string): Promise<Profile> => post("/api/profile", { category, value }).then(normalizeProfile),
  delProfile: (category: string, index: number): Promise<Profile> => req(`/api/profile/${category}/${index}`, { method: "DELETE" }).then(j).then(normalizeProfile),
  clearProfile: (): Promise<Profile> => req("/api/profile", { method: "DELETE" }).then(j).then(normalizeProfile),
  logout: (): Promise<{ ok: boolean }> => post("/api/auth/logout"),
  setPaused: (paused: boolean): Promise<Profile> => post("/api/settings/pause", { paused }).then(normalizeProfile),
};
