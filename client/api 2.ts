import type { WebTask, ConnectionStatus } from "../shared/types.ts";

const j = async (r: Response) => {
  if (!r.ok && r.status !== 401) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  return r.json();
};
const post = (url: string, body?: unknown) =>
  fetch(url, { method: "POST", headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined }).then(j);

export const api = {
  status: (): Promise<ConnectionStatus> => fetch("/api/status").then(j),
  tasks: (): Promise<WebTask[]> => fetch("/api/tasks").then(j),
  generate: (): Promise<WebTask[]> => post("/api/tasks/generate"),
  add: (title: string): Promise<WebTask[]> => post("/api/tasks", { title }),
  run: (id: string): Promise<WebTask> => post(`/api/tasks/${id}/run`),
  confirm: (id: string): Promise<WebTask[]> => post(`/api/tasks/${id}/confirm`),
  reject: (id: string): Promise<WebTask[]> => post(`/api/tasks/${id}/reject`),
  dismiss: (id: string): Promise<WebTask[]> => post(`/api/tasks/${id}/dismiss`),
  toggle: (id: string, index: number): Promise<WebTask[]> => post(`/api/tasks/${id}/toggle/${index}`),
  memory: (): Promise<string[]> => fetch("/api/memory").then(j),
  addMemory: (fact: string): Promise<string[]> => post("/api/memory", { fact }),
  delMemory: (index: number): Promise<string[]> => fetch(`/api/memory/${index}`, { method: "DELETE" }).then(j),
  logout: (): Promise<{ ok: boolean }> => post("/api/logout"),
};
