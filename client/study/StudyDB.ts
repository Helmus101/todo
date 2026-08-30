// IndexedDB wrapper for Study Mode
// All workspace state is local-first; cloud sync is separate.

import type { StudyEnvironment, ArtifactState, SessionLog } from "./StudyTypes.ts";

const DB_NAME = "otto-study";
const DB_VERSION = 2; // bumped to add the "files" store (uploaded audio) — existing users' v1 DBs upgrade in place

let _db: IDBDatabase | null = null;

function openDB(): Promise<IDBDatabase> {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains("environments")) {
        db.createObjectStore("environments", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("artifacts")) {
        const store = db.createObjectStore("artifacts", { keyPath: "id" });
        store.createIndex("by_env", "environmentId", { unique: false });
      }
      if (!db.objectStoreNames.contains("sessions")) {
        const s = db.createObjectStore("sessions", { keyPath: "id" });
        s.createIndex("by_task", "taskId", { unique: false });
      }
      if (!db.objectStoreNames.contains("files")) {
        db.createObjectStore("files"); // out-of-line keys — value is a raw Blob (uploaded audio, etc.)
      }
    };
    req.onsuccess = () => {
      _db = req.result;
      resolve(_db);
    };
    req.onerror = () => reject(req.error);
  });
}

function tx(
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest | void
): Promise<unknown> {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(storeName, mode);
        const store = t.objectStore(storeName);
        const req = fn(store);
        if (req) {
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        } else {
          t.oncomplete = () => resolve(undefined);
          t.onerror = () => reject(t.error);
        }
      })
  );
}

// ── Environments ──────────────────────────────────────────────────────────────

export async function getEnvironment(id: string): Promise<StudyEnvironment | undefined> {
  return tx("environments", "readonly", (s) => s.get(id)) as Promise<StudyEnvironment | undefined>;
}

export async function saveEnvironment(env: StudyEnvironment): Promise<void> {
  await tx("environments", "readwrite", (s) => s.put(env));
}

export async function getEnvironmentByTask(taskId: string): Promise<StudyEnvironment | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction("environments", "readonly");
    const store = t.objectStore("environments");
    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return resolve(undefined);
      if ((cursor.value as StudyEnvironment).taskId === taskId) {
        resolve(cursor.value as StudyEnvironment);
      } else {
        cursor.continue();
      }
    };
    req.onerror = () => reject(req.error);
  });
}

// ── Sessions ──────────────────────────────────────────────────────────────────

export async function saveSession(session: SessionLog): Promise<void> {
  await tx("sessions", "readwrite", (s) => s.put(session));
}

// ── Files (uploaded audio, etc.) ───────────────────────────────────────────────

export async function saveFile(id: string, blob: Blob): Promise<void> {
  await tx("files", "readwrite", (s) => s.put(blob, id));
}

export async function getFile(id: string): Promise<Blob | undefined> {
  return tx("files", "readonly", (s) => s.get(id)) as Promise<Blob | undefined>;
}

export async function deleteFile(id: string): Promise<void> {
  await tx("files", "readwrite", (s) => s.delete(id));
}

export async function getSessionsByTask(taskId: string): Promise<SessionLog[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction("sessions", "readonly");
    const store = t.objectStore("sessions");
    const idx = store.index("by_task");
    const req = idx.getAll(taskId);
    req.onsuccess = () => resolve(req.result as SessionLog[]);
    req.onerror = () => reject(req.error);
  });
}
