import { useEffect, useState, useCallback, useRef } from "react";
import type { WebTask, ConnectionStatus, Profile, TaskStep } from "../shared/types.ts";
import { api, type IntegrationItem } from "./api.ts";

const PRIORITY: Record<string, { label: string; cls: string }> = {
  do: { label: "Do now", cls: "p0" },
  schedule: { label: "Schedule", cls: "p1" },
  delegate: { label: "Quick", cls: "p2" },
  later: { label: "Later", cls: "p3" },
};
const prio = (t: WebTask) => PRIORITY[t.quadrant] || PRIORITY.schedule;

function subtitle(t: WebTask): string {
  if (t.status === "running") return "Working on it…";
  if (t.status === "executed") {
    const n = (t.steps || []).filter((s) => !s.done && !s.automatable).length;
    return n ? `${n} thing${n > 1 ? "s" : ""} need${n > 1 ? "" : "s"} you` : "Done for you";
  }
  return t.why;
}

// Open a URL in a new tab. Prefers the Otto Chrome extension (web/extension/) — it sets a DOM flag and
// relays postMessage to chrome.tabs.create, so tabs can open UNATTENDED during auto-do. Without it, falls
// back to window.open (works on a user click).
const TAB_GROUP = "Otto"; // all tabs Otto opens go into this one named group
const extPresent = () => document.documentElement.getAttribute("data-weave-ext") === "1";
// Open one or many tabs. With the extension, they go into a NAMED tab group (per task); without it,
// window.open (no grouping possible from a plain page).
function openTab(url: string, group?: string) {
  if (extPresent()) window.postMessage({ type: "weave-open-tab", url, group }, window.location.origin);
  else window.open(url, "_blank", "noopener");
}
function openTabs(urls: string[], group?: string) {
  if (!urls.length) return;
  if (extPresent()) window.postMessage({ type: "weave-open-tabs", urls, group }, window.location.origin);
  else urls.forEach((u) => window.open(u, "_blank", "noopener"));
}

// Auto-open created documents (Doc/Sheet/Slides) when a task finishes — handy, but capped so you're never
// flooded with tabs, only via the extension (a plain window.open would be popup-blocked without a click),
// and EACH doc opens at most ONCE EVER. The opened-URL set is PERSISTED (localStorage) so reopening the app
// never re-opens the same tabs again. Toggle in Settings (default ON).
const DOC_RE = /docs\.google\.com\/(document|spreadsheets|presentation)/i;
const OPENED_KEY = "otto-opened-docs";
const openedDocs: Set<string> = (() => { try { return new Set<string>(JSON.parse(localStorage.getItem(OPENED_KEY) || "[]")); } catch { return new Set(); } })();
const markDocsOpened = (urls: string[]) => {
  urls.forEach((u) => openedDocs.add(u));
  try { localStorage.setItem(OPENED_KEY, JSON.stringify([...openedDocs].slice(-300))); } catch { /* ignore */ }
};
let sessionDocsOpened = 0;               // burst control: cap how many open within one session load
const SESSION_DOC_CAP = 4;               // ceiling on auto-opened docs per session load
const PER_TASK_DOC_CAP = 2;              // and per task
const autoOpenDocsOn = () => { try { return localStorage.getItem("otto-autoopen-docs") !== "0"; } catch { return true; } };

/** Render context/synthesis as a clean bullet list (one bullet per line; leading -/•/* stripped). Full
 *  text always shown — never truncated. Falls back to a single line if there's just one. */
function Bullets({ text }: { text: string }) {
  const items = (text || "").split("\n").map((l) => l.replace(/^\s*[-•*]\s*/, "").trim()).filter(Boolean);
  if (items.length <= 1) return <p>{items[0] || text}</p>;
  return <ul className="bullets">{items.map((b, i) => <li key={i}>{b}</li>)}</ul>;
}

/** The Otto mark — a to-do list (three dots + lines) with a check sweeping through the last item.
 *  Uses currentColor so it inherits the brand text colour (and inverts in dark mode). */
function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="3.7" cy="6" r="1.85" fill="currentColor" />
      <circle cx="3.7" cy="12" r="1.85" fill="currentColor" />
      <circle cx="3.7" cy="18" r="1.85" fill="currentColor" />
      <rect x="7.6" y="4.75" width="10.4" height="2.5" rx="1.25" fill="currentColor" />
      <rect x="7.6" y="10.75" width="11.6" height="2.5" rx="1.25" fill="currentColor" />
      <rect x="7.6" y="16.75" width="3.3" height="2.5" rx="1.25" fill="currentColor" />
      <path d="M10 16 L13.7 19.7 L21.6 10.2" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Strip leading/trailing slashes → the bare route ("" = dashboard, "settings", "login", "task/<id>"). */
const routeOf = (pathname: string) => pathname.replace(/^\/+/, "").replace(/\/+$/, "");

/**
 * Tiny dependency-free History-API router (clean paths like /login, /settings, /task/<id> — no hash).
 * Both the Vite dev server and the Express prod server fall back to index.html for any path, so a deep
 * link or refresh resolves. A delegated click handler routes internal <a href="/..."> links in-app
 * (no full reload) — but lets REAL server routes (/auth/*, /api/*) and new-tab/download links through.
 */
function usePathRoute(): [string, (r: string) => void] {
  const [route, setRoute] = useState(routeOf(window.location.pathname));
  useEffect(() => {
    const on = () => setRoute(routeOf(window.location.pathname));
    window.addEventListener("popstate", on);
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as HTMLElement)?.closest?.("a");
      const href = a?.getAttribute("href");
      if (!a || !href || !href.startsWith("/") || href.startsWith("//") || a.target === "_blank" || a.hasAttribute("download")) return;
      if (href.startsWith("/auth") || href.startsWith("/api") || href.startsWith("/integrations")) return; // real server routes — let the browser navigate
      e.preventDefault();
      navigate(routeOf(href));
    };
    document.addEventListener("click", onClick);
    return () => { window.removeEventListener("popstate", on); document.removeEventListener("click", onClick); };
  }, []);
  return [route, navigate];
}

// Remember the signed-in state across reloads so a returning user lands straight on their dashboard
// (no login flash). It's reconciled with the server on load — the cookie session is the real source.
const CACHED_STATUS: ConnectionStatus | null = (() => {
  try { return JSON.parse(localStorage.getItem("weave-status") || "null"); } catch { return null; }
})();

const GREETING = () => { const h = new Date().getHours(); return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"; };
/** A friendly first name from the account email's local part ("tjong.willem@…" → "Tjong"). Personalizes the UI. */
const firstName = (user?: string) => {
  const local = (user || "").split("@")[0].split(/[._+-]+/)[0];
  return local ? local.charAt(0).toUpperCase() + local.slice(1) : "";
};

/** Navigate the path router. "" → "/" (dashboard); otherwise "/<route>" (e.g. "task/<id>", "settings").
 *  pushState doesn't fire popstate, so we dispatch one to notify the router hook. */
const navigate = (r: string) => {
  window.history.pushState({}, "", r ? `/${r}` : "/");
  window.dispatchEvent(new PopStateEvent("popstate"));
};

export function App() {
  const [status, setStatus] = useState<ConnectionStatus | null>(CACHED_STATUS);
  const [route] = usePathRoute();
  const [tasks, setTasks] = useState<WebTask[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [extOn, setExtOn] = useState(extPresent()); // is the Otto Tabs extension present? (it sets data-weave-ext)
  const [introSeen, setIntroSeen] = useState(() => { try { return localStorage.getItem("otto-intro") === "1"; } catch { return false; } });
  const [onboard, setOnboard] = useState(() => { try { return localStorage.getItem("otto-onboard") === "1"; } catch { return false; } });
  const [loadError, setLoadError] = useState(false); // backend unreachable after retries → show a retry screen
  const [reloadKey, setReloadKey] = useState(0);      // bump to re-attempt the status fetch
  const startOnboard = () => { try { localStorage.setItem("otto-onboard", "1"); } catch { /* ignore */ } setOnboard(true); };
  const finishOnboard = () => { try { localStorage.removeItem("otto-onboard"); localStorage.setItem("otto-intro", "1"); } catch { /* ignore */ } setOnboard(false); setIntroSeen(true); };
  const dismissIntro = () => { try { localStorage.setItem("otto-intro", "1"); } catch { /* ignore */ } setIntroSeen(true); };
  const [showCompleted, setShowCompleted] = useState(false);
  const generatedOnce = useRef(false);
  const inflight = useRef<Set<string>>(new Set()); // ids currently auto-running (bounded concurrency)
  const attempts = useRef<Map<string, number>>(new Map()); // per-task auto-run attempts (capped retry)
  const RUN_LIMIT = 3;            // run a few at once so the list clears faster (cheap now that tools are cached)
  const RUN_TIMEOUT_MS = 120_000; // a stuck run can never wedge the whole queue

  const loadStatus = useCallback(async () => { try { setStatus(await api.status()); } catch { /* keep last */ } }, []);

  // Persist the signed-in state so a returning user skips the login flash (reconciled on next load).
  useEffect(() => {
    try { status ? localStorage.setItem("weave-status", JSON.stringify(status)) : localStorage.removeItem("weave-status"); } catch { /* ignore */ }
  }, [status]);

  // The content script sets data-weave-ext at document_start; re-check shortly after mount in case of timing.
  useEffect(() => { const id = setTimeout(() => setExtOn(extPresent()), 600); return () => clearTimeout(id); }, []);

  // Retry status until the backend is reachable (tsx dev-server boot race) — don't get stuck on the spinner.
  // After the retries are exhausted, surface a real "can't reach the server" screen instead of a forever-spinner.
  useEffect(() => {
    let stop = false, tries = 0;
    const tick = async () => {
      if (stop) return;
      try { const s = await api.status(); if (!stop) { setStatus(s); setLoadError(false); } }
      catch { if (!stop) { if (tries++ < 30) setTimeout(tick, 1000); else setLoadError(true); } }
    };
    void tick();
    return () => { stop = true; };
  }, [reloadKey]);

  const connected = !!status?.googleConnected;

  // Once Google is connected: load tasks + trigger daily auto-generate (silent, in background).
  useEffect(() => {
    if (!connected) return;
    void (async () => {
      const retry = (list: WebTask[]) => list.map((x) => (x.status === "ready" && x.autoRan && !x.synthesis ? { ...x, autoRan: false } : x));
      const t = retry(await api.tasks().catch(() => [] as WebTask[]));
      setTasks(t);
      // Silently trigger daily generation in background (doesn't block UI). Server checks if we've already
      // generated today; if not, queues a scan and returns immediately.
      void api.generate().catch(() => {});
    })();
  }, [connected, status?.aiReady]);

  // Auto-run, client-driven with BOUNDED CONCURRENCY: keep up to RUN_LIMIT ready tasks running at once.
  // Each run is synchronous server-side (returns the executed task) and races a timeout so a single slow
  // or hung run can never block the rest of the list. Completion re-renders → this effect picks the next.
  useEffect(() => {
    if (!connected) return;
    const slots = RUN_LIMIT - inflight.current.size;
    if (slots <= 0) return;
    const next = tasks.filter((t) => t.status === "ready" && !t.autoRan && !inflight.current.has(t.id)).slice(0, slots);
    if (!next.length) return;
    for (const task of next) {
      inflight.current.add(task.id);
      setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, status: "running" } : t)));
      let timer: ReturnType<typeof setTimeout>;
      const timeout = new Promise<WebTask>((_, rej) => { timer = setTimeout(() => rej(new Error("timeout")), RUN_TIMEOUT_MS); });
      Promise.race([api.run(task.id), timeout])
        // If the user dismissed/confirmed the task while it was running, keep THEIR state — never resurrect it.
        .then((u) => { if (u && u.id) { attempts.current.delete(u.id); setTasks((prev) => prev.map((t) => (t.id === u.id ? (t.status === "dismissed" || t.status === "done" ? t : u) : t))); } })
        .catch(() => {
          // Pause this task now. A failure is often transient (the dev server restarted mid-run → socket
          // hang up). Retry a couple of times with a short delay; only give up (stay paused, user can hit
          // Run again) after that, so a real fault doesn't loop forever.
          const n = (attempts.current.get(task.id) || 0) + 1;
          attempts.current.set(task.id, n);
          setTasks((prev) => prev.map((t) => (t.id === task.id ? (t.status === "dismissed" || t.status === "done" ? t : { ...t, status: "ready", autoRan: true }) : t)));
          if (n < 3) setTimeout(() => setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, autoRan: false } : t))), 5000);
        })
        .finally(() => { clearTimeout(timer); inflight.current.delete(task.id); });
    }
  }, [tasks, connected]);

  // NO background auto-generate: each sweep is a full multi-tool agent pass (real API credits). Tasks are
  // found on app load (throttled above) and via the ↻ Refresh button — that's it. Leaving the tab open all
  // day costs nothing.

  const generate = async () => {
    setBusy(true); setNote("");
    try { const t = await api.generate(); setTasks(t); try { localStorage.setItem("otto-lastgen", String(Date.now())); } catch { /* ignore */ } if (!t.length) setNote("Nothing actionable in your recent inbox + calendar right now."); }
    catch (e: any) { setNote(`Couldn't generate tasks: ${e?.message || "error"}`); }
    finally { setBusy(false); }
  };
  const signOut = async () => { await api.logout(); setTasks([]); generatedOnce.current = false; navigate(""); void loadStatus(); };

  // Signed in, the dashboard lives at /tasks. Redirect the bare "/" there (landing only shows signed-OUT).
  useEffect(() => { if (status?.loggedIn && route === "") navigate("tasks"); }, [status?.loggedIn, route]);

  if (!status) {
    if (loadError) return (
      <div className="screen crash">
        <div className="crash-card">
          <h1>Can't reach Otto</h1>
          <p>The server isn't responding. Check your connection and try again.</p>
          <button className="btn primary big" onClick={() => { setLoadError(false); setReloadKey((k) => k + 1); }}>Try again</button>
        </div>
      </div>
    );
    return <div className="screen"><div className="brand boot"><Logo size={26} /> Otto</div><div className="spinner" /></div>;
  }
  if (!status.loggedIn) {
    return route === "login" || route === "signup"
      ? <LoginPage status={status} onDone={async (isNew) => { if (isNew) startOnboard(); await loadStatus(); navigate("tasks"); }} initialMode={route === "signup" ? "signup" : "login"} />
      : <Landing />;
  }

  const live = tasks.filter((t) => t.status !== "done" && t.status !== "dismissed").sort((a, b) => b.score - a.score);
  const completed = tasks.filter((t) => t.status === "done").sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const working = tasks.filter((t) => t.status === "running").length;
  const handled = completed.length;
  const openId = route.startsWith("task/") ? route.slice(5) : null; // the deep-linked task, if any

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><Logo size={20} /> Otto</div>
        <nav className="tabs">
          <a className={`tab ${route === "" || route === "tasks" || route.startsWith("task/") ? "active" : ""}`} href="/tasks">Tasks</a>
          <a className={`tab ${route === "settings" ? "active" : ""}`} href="/settings">Settings</a>
        </nav>
        <div className="spacer" />
        {extOn && <span className="ext-chip" title="Otto Tabs extension is connected — pages open automatically">Tabs connected</span>}
        {(route === "" || route === "tasks" || route.startsWith("task/")) && status.googleConnected && <button className="btn ghost" disabled={busy} onClick={() => void generate()}>{busy ? "Finding…" : "Refresh"}</button>}
      </header>

      {onboard && <Onboarding onStatus={loadStatus} onDone={finishOnboard} />}

      {route === "settings" ? (
        <SettingsPage status={status} onSignOut={signOut} onChanged={loadStatus} />
      ) : route === "chat" ? (
        <ChatPage />
      ) : !status.googleConnected ? (
        <main className="list-wrap"><ConnectCard status={status} /></main>
      ) : (
        <main className="list-wrap" key="dash">
          <div className="dash-head">
            <h1 className="list-head">{GREETING()}{(status.name || firstName(status.user)) ? <>, <span>{status.name || firstName(status.user)}</span></> : null}.</h1>
            <div className="list-status">
              <span><b>{live.length}</b> active</span>
              {working ? <span> · <b>{working}</b> running</span> : null}
              {handled ? <span className="dash-stat-link" onClick={() => setShowCompleted((v) => !v)}> · <b>{handled}</b> completed {showCompleted ? "−" : "+"}</span> : null}
            </div>
          </div>
          {!introSeen && (
            <div className="intro">
              <div className="intro-body">
                <div className="intro-title">How it works</div>
                <p>Click the button above once per day. Otto scans your inbox, calendar & files then quietly does what it safely can — drafting replies, prepping docs. You review & confirm.</p>
              </div>
              <button className="btn xs ghost" onClick={dismissIntro}>Got it</button>
            </div>
          )}
          <AddTask onAdded={setTasks} />
          {/* If a deep link points at a task that's already handled (not in the live list), surface it so the URL still resolves. */}
          {(() => {
            const shown = openId && !live.some((t) => t.id === openId)
              ? [...live, ...tasks.filter((t) => t.id === openId)]
              : live;
            if (shown.length === 0 && busy) return <TaskSkeleton />;
            return shown.length === 0
              ? <div className="empty">{note || `You're all clear${(status.name || firstName(status.user)) ? `, ${status.name || firstName(status.user)}` : ""}. New mail or meetings show up here.`}</div>
              : <div className="list">{shown.map((t) => (
                  <Card
                    key={t.id}
                    task={t}
                    open={t.id === openId}
                    onToggle={() => navigate(t.id === openId ? "" : `task/${t.id}`)}
                    onChange={setTasks}
                    onTask={(u) => setTasks((prev) => prev.map((x) => (x.id === u.id ? u : x)))}
                  />
                ))}</div>;
          })()}
          {showCompleted && completed.length > 0 && (
            <div className="completed-section">
              <h3 className="completed-head">Completed</h3>
              <div className="list">{completed.map((t) => (
                <Card
                  key={t.id}
                  task={t}
                  open={false}
                  onToggle={() => {}}
                  onChange={setTasks}
                  onTask={(u) => setTasks((prev) => prev.map((x) => (x.id === u.id ? u : x)))}
                />
              ))}</div>
            </div>
          )}
        </main>
      )}
    </div>
  );
}

/** Loading placeholder while Otto scans the inbox/calendar — shimmer cards so the screen never sits empty. */
function TaskSkeleton() {
  const widths = ["68%", "54%", "61%"];
  return (
    <div className="list" aria-hidden="true">
      {widths.map((w, i) => (
        <div key={i} className="card skel">
          <div className="card-main">
            <span className="skel-box skel-pill" />
            <div className="card-text">
              <div className="skel-box skel-line" style={{ width: w }} />
              <div className="skel-box skel-line sm" style={{ width: "36%" }} />
            </div>
          </div>
        </div>
      ))}
      <div className="skel-note">Looking through your inbox, calendar &amp; Drive…</div>
    </div>
  );
}

/** A connect-Gmail call to action — shown on the dashboard until Gmail is linked (via Composio, in Settings). */
function ConnectCard({ status }: { status: ConnectionStatus }) {
  return (
    <div className="connect-card">
      <h2>{(status.name || firstName(status.user)) ? `Welcome, ${status.name || firstName(status.user)}` : "Welcome to Otto"}</h2>
      <p>Connect Gmail to begin. Otto reads your inbox, calendar and Drive so it can do your to-dos — it only ever creates <b>drafts</b> and <b>docs</b>, and never sends without you.</p>
      {!status.googleConfigured && <div className="warn">Integrations aren't configured on the server (COMPOSIO_API_KEY).</div>}
      {!status.aiReady && <div className="warn">Server is missing DEEPSEEK_API_KEY — task generation is disabled.</div>}
      <a className="btn primary big" href="/settings">Connect in Settings</a>
    </div>
  );
}

/** The Settings PAGE (route /settings): account, ALL app connections (Composio — incl. Google), the
 *  person-profile editor, and exactly what Otto will/won't do. */
function SettingsPage({ status, onSignOut, onChanged }: { status: ConnectionStatus; onSignOut: () => void; onChanged: () => void }) {
  return (
    <main className="settings-page">
      <h1 className="settings-title">Settings</h1>

      <section className="settings-sec">
        <h3>Account</h3>
        <div className="modal-row"><span className="lbl">Signed in as</span><span className="val">{status.user}{status.cloud ? " · synced to cloud" : ""}</span></div>
        <div className="modal-row"><span className="lbl">Session</span><button className="btn xs" onClick={() => void onSignOut()}>Sign out</button></div>
      </section>

      <section className="settings-sec">
        <h3>Integrations</h3>
        <p className="settings-hint">Connect the apps you live in — start with <b>Gmail</b> and <b>Google Calendar</b> (that's what your to-dos are built from). Otto can read them and do the reversible work (draft a reply, create a doc, add a task). It can <b>never send, post, publish, or delete</b> on its own — those stay your call.</p>
        <Integrations onChanged={onChanged} />
      </section>

      <section className="settings-sec">
        <h3>Preferences</h3>
        <label className="pref-row">
          <input type="checkbox" defaultChecked={autoOpenDocsOn()} onChange={(e) => { try { localStorage.setItem("otto-autoopen-docs", e.target.checked ? "1" : "0"); } catch { /* ignore */ } }} />
          <span className="pref-text"><b>Open created documents automatically</b><span className="settings-hint">When Otto makes a Doc, Sheet or Slides, open it in a tab so you can review it — needs the Otto Tabs extension, and it's capped so you're never flooded.</span></span>
        </label>
      </section>

      <section className="settings-sec">
        <h3>What Otto knows about you</h3>
        <p className="settings-hint">Otto fills this in as it works — and it shapes how it chooses and does your to-dos. Edit anything.</p>
        <ProfileEditor />
      </section>

      <section className="settings-sec">
        <h3>What Otto can do</h3>
        <p className="settings-hint">Through your connected apps it can read your world and do the <b>reversible</b> work — draft replies, create docs/decks/sheets, add tasks, update issues. It can <b>never</b> do something irreversible on its own: no sending or forwarding email, no posting messages, no publishing, no deleting. Those always stay with you.</p>
      </section>
    </main>
  );
}

/** Integrations grid (Composio): one tile per app, grouped by category. Connect = redirect to the OAuth
 *  flow; Disconnect = revoke. Status is read live from Composio so a finished OAuth shows up on return. */
function Integrations({ onChanged }: { onChanged?: () => void }) {
  const [items, setItems] = useState<IntegrationItem[] | null>(null);
  const [ready, setReady] = useState(true);
  const [busy, setBusy] = useState("");
  const load = useCallback(async () => {
    try { const r = await api.integrations(); setItems(r.items); setReady(r.ready); onChanged?.(); }
    catch { setItems([]); }
  }, [onChanged]);
  useEffect(() => { void load(); }, [load]);
  // Returning from an OAuth redirect → refresh once shortly after mount so a just-connected app flips to ✓.
  useEffect(() => { const id = setTimeout(() => void load(), 1200); return () => clearTimeout(id); }, [load]);
  // Connect opens OAuth in a NEW TAB — so when the user comes back to this tab, re-check what's now connected.
  useEffect(() => {
    const on = () => { if (!document.hidden) void load(); };
    document.addEventListener("visibilitychange", on);
    window.addEventListener("focus", on);
    return () => { document.removeEventListener("visibilitychange", on); window.removeEventListener("focus", on); };
  }, [load]);

  const disconnect = async (key: string) => {
    if (busy) return;
    setBusy(key);
    try { await api.disconnectIntegration(key); await load(); } finally { setBusy(""); }
  };

  if (items === null) return <div className="muted small">Loading integrations…</div>;
  if (!ready) return <div className="warn">Integrations need <b>COMPOSIO_API_KEY</b> set on the server (it's in Otto's root <code>.env</code>). Restart the server after adding it.</div>;

  const cats = [...new Set(items.map((i) => i.category))];
  const count = items.filter((i) => i.connected).length;
  return (
    <div className="integrations">
      {count > 0 && <div className="muted small" style={{ marginBottom: 10 }}>{count} connected.</div>}
      {cats.map((cat) => (
        <div key={cat} className="int-group">
          <div className="int-cat">{cat}</div>
          <div className="int-grid">
            {items.filter((i) => i.category === cat).map((i) => (
              <div key={i.key} className={`int-tile ${i.connected ? "on" : ""}`}>
                <img className="int-logo" src={i.logo} alt="" loading="lazy" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
                <div className="int-info">
                  <div className="int-name">{i.name}{i.connected && <span className="int-dot" title="Connected" />}</div>
                  <div className="int-blurb">{i.blurb}</div>
                </div>
                {i.connected ? (
                  <button className="btn xs ghost" disabled={busy === i.key} onClick={() => void disconnect(i.key)}>{busy === i.key ? "…" : "Disconnect"}</button>
                ) : (
                  <a className="btn xs" href={`/integrations/${i.key}/connect`} target="_blank" rel="noreferrer">Connect ↗</a>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** First-run ONBOARDING for a brand-new account — a 3-step welcome overlay that explains Otto and walks the
 *  user through connecting their first apps (each connect opens in a new tab; we re-check on focus so a tile
 *  flips to ✓ when they come back). Shown once after sign-up; "Skip"/finish clears the otto-onboard flag. */
function Onboarding({ onStatus, onDone }: { onStatus: () => void; onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [items, setItems] = useState<IntegrationItem[] | null>(null);
  const saveName = async () => {
    const n = name.trim();
    if (n) { try { await api.setProfile("name", n); await onStatus(); } catch { /* non-blocking */ } }
    setStep(1);
  };
  const load = useCallback(async () => { try { const r = await api.integrations(); setItems(r.items); onStatus(); } catch { setItems([]); } }, [onStatus]);
  useEffect(() => { void load(); }, [load]);
  // Connect opens OAuth in a new tab → refresh connection state when the user returns to this tab.
  useEffect(() => {
    const on = () => { if (!document.hidden) void load(); };
    document.addEventListener("visibilitychange", on);
    window.addEventListener("focus", on);
    return () => { document.removeEventListener("visibilitychange", on); window.removeEventListener("focus", on); };
  }, [load]);

  const ESSENTIALS = ["gmail", "googlecalendar", "googledrive"];
  const essentials = (items || [])
    .filter((i) => ESSENTIALS.includes(i.key))
    .sort((a, b) => ESSENTIALS.indexOf(a.key) - ESSENTIALS.indexOf(b.key));
  const connectedCount = essentials.filter((i) => i.connected).length;

  return (
    <div className="onboard-overlay" role="dialog" aria-modal="true">
      <div className="onboard-card">
        <button className="onboard-skip" onClick={onDone} aria-label="Skip onboarding">Skip</button>
        <div className="onboard-brand"><Logo size={22} /> <span>Otto</span></div>
        {step === 0 && (
          <div className="onboard-step">
            <h2>Welcome to Otto</h2>
            <p className="onboard-lead">Otto is a to-do list that does itself. It reads your inbox, calendar &amp; files, quietly does the reversible work — drafting replies, prepping docs, organizing tasks — and surfaces only what needs you.</p>
            <ul className="onboard-points">
              <li>Done for you — ready to review</li>
              <li>Needs you — a decision, a send, a payment</li>
              <li>Completed — checked off</li>
            </ul>
            <label className="field onboard-name"><span>What should Otto call you?</span>
              <input className="addinput" placeholder="Your name" value={name} maxLength={60} autoFocus
                onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void saveName(); }} />
            </label>
            <div className="onboard-actions"><button className="btn primary big" onClick={() => void saveName()}>Get started</button></div>
          </div>
        )}
        {step === 1 && (
          <div className="onboard-step">
            <h2>Connect your apps</h2>
            <p className="onboard-lead">Connect at least Gmail and Calendar so Otto has something to work with. Each opens in a new tab — finish the sign-in there, then come back.</p>
            {items === null ? <div className="muted small">Loading…</div> : (
              <div className="onboard-apps">
                {essentials.map((i) => (
                  <div key={i.key} className={`onboard-app ${i.connected ? "on" : ""}`}>
                    <img className="int-logo" src={i.logo} alt="" loading="lazy" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
                    <div className="onboard-app-name">{i.name}</div>
                    {i.connected
                      ? <span className="onboard-app-ok">Connected</span>
                      : <a className="btn xs" href={`/integrations/${i.key}/connect`} target="_blank" rel="noreferrer">Connect ↗</a>}
                  </div>
                ))}
              </div>
            )}
            <p className="muted small">More apps (Slack, Notion, GitHub…) live in Settings whenever you want them.</p>
            <div className="onboard-actions">
              <button className="btn primary big" onClick={() => setStep(2)}>{connectedCount ? `Continue — ${connectedCount} connected` : "Skip for now"}</button>
            </div>
          </div>
        )}
        {step === 2 && (
          <div className="onboard-step">
            <h2>You're all set</h2>
            <p className="onboard-lead">{connectedCount ? "Otto will start finding things it can do for you. Anything needing your call shows up as a task — review, then one click to send." : "Connect an app any time from Settings and Otto will get to work."}</p>
            <div className="onboard-actions"><button className="btn primary big" onClick={onDone}>Go to my tasks</button></div>
          </div>
        )}
        <div className="onboard-dots">{[0, 1, 2].map((d) => <span key={d} className={d === step ? "on" : ""} />)}</div>
      </div>
    </div>
  );
}

/** Chat PAGE (route /chat): a DeepSeek-backed assistant that can search the web (DuckDuckGo fallback) and
 *  knows the user's profile + current to-dos. Sources render as clickable chips under each answer. */
function ChatPage() {
  const [msgs, setMsgs] = useState<{ role: "user" | "assistant"; content: string; sources?: { title: string; url: string }[]; via?: string }[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs, busy]);

  const send = async () => {
    const q = text.trim();
    if (!q || busy) return;
    const next = [...msgs, { role: "user" as const, content: q }];
    setMsgs(next); setText(""); setBusy(true);
    try {
      const r = await api.chat(next.map((m) => ({ role: m.role, content: m.content })));
      setMsgs((prev) => [...prev, { role: "assistant", content: r.reply, sources: r.sources, via: r.via }]);
    } catch (e: any) {
      setMsgs((prev) => [...prev, { role: "assistant", content: `Sorry — ${e?.message || "something went wrong"}.` }]);
    } finally { setBusy(false); }
  };

  return (
    <main className="chat-page">
      <div className="chat-scroll">
        {msgs.length === 0 && (
          <div className="chat-empty">
            <h2>Ask Otto anything.</h2>
            <p>It can search the web for current facts, and it knows your profile and what's on your plate. Try "what's new with my projects?" or "summarize the latest on X".</p>
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`chat-msg ${m.role}`}>
            <div className="chat-bubble">
              {m.content.split("\n").map((line, j) => <p key={j}>{line || " "}</p>)}
              {m.sources?.length ? (
                <div className="chat-sources">
                  {m.sources.map((s, k) => <a key={k} className="chat-src" href={s.url} target="_blank" rel="noreferrer" title={s.url}>{s.title}</a>)}
                </div>
              ) : null}
            </div>
          </div>
        ))}
        {busy && <div className="chat-msg assistant"><div className="chat-bubble muted">Thinking…</div></div>}
        <div ref={endRef} />
      </div>
      <div className="chat-input">
        <input
          className="addinput"
          placeholder="Message Otto…"
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
          autoFocus
        />
        <button className="btn primary" disabled={busy || !text.trim()} onClick={() => void send()}>{busy ? "…" : "Send"}</button>
      </div>
    </main>
  );
}

/** Dedicated login / sign-up PAGE (routes /login and /signup). Its own clean, centered card. */
function LoginPage({ status, onDone, initialMode }: { status: ConnectionStatus; onDone: (isNew?: boolean) => void; initialMode: "login" | "signup" }) {
  const [mode, setMode] = useState<"login" | "signup">(initialMode);
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (busy || !email.trim() || !pw) return;
    setBusy(true); setErr("");
    try {
      const r = mode === "signup" ? await api.signup(email.trim(), pw) : await api.login(email.trim(), pw);
      if (r.ok) onDone(mode === "signup"); else setErr(r.error || "Something went wrong.");
    } catch {
      setErr("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login-page">
      <header className="landing-nav"><a className="brand" href="/"><Logo size={20} /> Otto</a></header>
      <main className="login-main">
        <div className="login-card">
          <h1 className="login-title">{mode === "signup" ? "Create your account" : "Welcome back"}</h1>
          <p className="login-sub">{mode === "signup" ? "Two fields and you're in — connect Google next." : "Log in to pick up where Otto left off."}</p>
          {!status.cloud && <div className="warn">Accounts need Supabase configured on the server.</div>}
          <label className="field"><span>Email</span>
            <input className="addinput" type="email" autoComplete="email" placeholder="you@email.com" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          </label>
          <label className="field"><span>Password</span>
            <input className="addinput" type="password" autoComplete={mode === "signup" ? "new-password" : "current-password"} placeholder="At least 6 characters" value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void submit(); }} />
          </label>
          {err && <div className="autherr">{err}</div>}
          <button className="btn primary big" disabled={busy || !email.trim() || !pw} onClick={() => void submit()}>{busy ? "…" : mode === "signup" ? "Create account" : "Log in"}</button>
          <button className="btn ghost" onClick={() => { setMode((m) => (m === "signup" ? "login" : "signup")); setErr(""); }}>
            {mode === "signup" ? "Have an account? Log in" : "New here? Create an account"}
          </button>
          <a className="login-back" href="/">← Back to home</a>
        </div>
      </main>
    </div>
  );
}

/** Marketing landing (signed out, route /). CTAs route to the dedicated login / sign-up page. */
function Landing() {
  return (
    <div className="landing">
      <header className="landing-nav">
        <span className="brand"><Logo size={22} /> Otto</span>
        <nav className="landing-navlinks">
          <a className="btn ghost" href="/login">Log in</a>
          <a className="btn primary" href="/signup">Get started</a>
        </nav>
      </header>

      <main className="hero">
        <span className="hero-eyebrow"><span className="live-dot" /> Your day, quietly handled</span>
        <h1 className="hero-title">The to-do list that <em>does itself</em>.</h1>
        <p className="hero-sub">Otto reads your inbox, calendar and Drive — then gets ahead of the work. It drafts the replies, preps the docs, and clears your list before you have to ask.</p>
        <div className="hero-cta">
          <a className="btn primary" href="/signup">Get started — it's free</a>
          <a className="btn" href="/login">Log in</a>
        </div>
        {/* Bento — show the product working instead of describing it. */}
        <div className="bento" aria-hidden="true">
          <div className="bento-box tall">
            <div className="bento-label"><span className="live-dot" /> Live — drafting in your voice</div>
            <div className="demo-window">
              <div className="demo-titlebar"><span /><span /><span /></div>
              <div className="demo-body">
                <p className="demo-line"><b>To:</b> sarah@acme.com</p>
                <p className="demo-line"><b>Subject:</b> Re: Q3 budget review</p>
                <p className="demo-line" style={{ marginTop: 8 }}>hi sarah,</p>
                <p className="demo-line">sounds good — thursday works. i'll bring the updated numbers and we can walk through the deltas together<span className="demo-caret" /></p>
              </div>
            </div>
          </div>
          <div className="bento-box">
            <div className="bento-label">Synced</div>
            <div className="sync-row">
              <span className="sync-chip"><img src="https://logos.composio.dev/api/gmail" alt="" />Gmail</span>
              <span className="sync-chip"><img src="https://logos.composio.dev/api/googlecalendar" alt="" />Calendar</span>
              <span className="sync-chip"><img src="https://logos.composio.dev/api/googledrive" alt="" />Drive</span>
              <span className="sync-chip"><img src="https://logos.composio.dev/api/slack" alt="" />Slack</span>
            </div>
          </div>
          <div className="bento-box">
            <div className="bento-label">Quietly handled</div>
            <div className="ticker-num">14</div>
            <div className="ticker-sub">tasks cleared today — drafts, docs &amp; prep, ready for your OK</div>
          </div>
        </div>

        <div className="fineprint" style={{ marginTop: 28 }}>Only ever drafts &amp; docs — Otto never sends anything without you.</div>
      </main>

      <section className="landing-sec">
        <h2>How it works</h2>
        <p className="lead">Connect once. From then on Otto watches the things that actually need you — and quietly gets ahead of them.</p>
        <div className="how">
          <div className="how-step"><div className="n">01</div><h3>It reads your world</h3><p>Inbox, calendar and Drive — pulling out the few things that genuinely need a reply, a decision, or prep.</p></div>
          <div className="how-step"><div className="n">02</div><h3>It does the work</h3><p>Drafts the reply in your voice, builds the doc, gathers the context — then shows you exactly what it did.</p></div>
          <div className="how-step"><div className="n">03</div><h3>You just confirm</h3><p>Open a draft, tweak it, send. Anything only you can do is laid out as a short, tickable checklist.</p></div>
        </div>
      </section>

      <section className="landing-sec">
        <h2>Built to be trusted</h2>
        <div className="features">
          <div className="feature"><div><h3>Drafts, never sends</h3><p>Every email is a draft you review. Nothing leaves your account without your explicit OK.</p></div></div>
          <div className="feature"><div><h3>Learns who you are</h3><p>It remembers your people, projects and preferences, so its work sounds like you — and sharpens over time.</p></div></div>
          <div className="feature"><div><h3>Your account, your data</h3><p>Saved privately to your account. It reads your apps and creates drafts &amp; docs — nothing destructive.</p></div></div>
          <div className="feature"><div><h3>Clears itself</h3><p>Reversible work happens in the background. You open the app to a list that's already half-done.</p></div></div>
        </div>
      </section>

      <section className="cta-band">
        <h2>Stop managing your to-do list.</h2>
        <p>Let Otto read your world and clear what it can — you just confirm the rest.</p>
        <a className="btn big cta-band-btn" href="/signup">Get started — it's free</a>
      </section>

      <div className="landing-foot">Otto — the to-do list that does itself.</div>
    </div>
  );
}

const SOURCE: Record<string, string> = {
  gmail: "Gmail", calendar: "Calendar", googlecalendar: "Calendar", manual: "You",
  slack: "Slack", discord: "Discord", twitter: "X", linkedin: "LinkedIn",
  github: "GitHub", linear: "Linear", jira: "Jira", notion: "Notion",
  todoist: "Todoist", asana: "Asana", trello: "Trello", clickup: "ClickUp",
  perplexity: "Perplexity", calendly: "Calendly", hubspot: "HubSpot", airtable: "Airtable",
  googledocs: "Docs", googledrive: "Drive", googlesheets: "Sheets", googleslides: "Slides",
};
/** A friendly label for a task's source app — known apps get an emoji/name, anything else is Title-cased. */
const sourceLabel = (s: string) => SOURCE[s] || (s ? s[0].toUpperCase() + s.slice(1) : "Task");

/** The person-profile editor (lives in the Settings page): about + preferences + people + projects.
 *  Otto fills it in as it works; it's injected into how tasks are chosen + done. Always expanded here. */
function ProfileEditor() {
  const [p, setP] = useState<Profile | null>(null);
  useEffect(() => { void api.profile().then(setP).catch(() => setP(null)); }, []);
  if (!p) return <p className="muted small">Loading…</p>;
  const count = (p.name ? 1 : 0) + (p.about ? 1 : 0) + p.preferences.length + p.people.length + p.projects.length;
  const lists = [
    { key: "preference" as const, label: "Preferences", items: p.preferences },
    { key: "person" as const, label: "People", items: p.people },
    { key: "project" as const, label: "Projects", items: p.projects },
  ];
  return (
    <div className="memory-body">
      <NameRow name={p.name || ""} onSave={async (v) => setP(await api.setProfile("name", v))} />
      <AboutRow about={p.about} onSave={async (v) => setP(await api.setProfile("about", v))} />
      {lists.map((l) => (
        <div className="prof-group" key={l.key}>
          <div className="prof-label">{l.label}</div>
          <ul className="memory-list">
            {l.items.map((it, i) => (
              <li key={i}><span>{it}</span><button className="x" title="Remove" onClick={async () => setP(await api.delProfile(l.key, i))}>×</button></li>
            ))}
          </ul>
          <AddRow placeholder={`Add a ${l.label.toLowerCase().replace(/s$/, "")}…`} onAdd={async (v) => setP(await api.setProfile(l.key, v))} />
        </div>
      ))}
      {count === 0
        ? <div className="muted small">Empty for now — Otto fills this in as it works, or add your name, about, preferences, people and projects here.</div>
        : <div className="forget-row">
            <button
              className="btn xs forget"
              onClick={async () => { if (window.confirm("Forget everything Otto has learned about you? This clears your About, preferences, people and projects, and can't be undone.")) setP(await api.clearProfile()); }}
            >Forget everything</button>
            <span className="muted small">Wipes Otto's memory — it starts from zero and learns you again as it works.</span>
          </div>}
    </div>
  );
}

function NameRow({ name, onSave }: { name: string; onSave: (v: string) => Promise<void> }) {
  const [text, setText] = useState(name);
  useEffect(() => { setText(name); }, [name]);
  return (
    <div className="prof-group">
      <div className="prof-label">Name</div>
      <div className="addrow">
        <input className="addinput sm" placeholder="What should Otto call you?" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void onSave(text.trim()); }} />
        <button className="btn" disabled={text.trim() === name.trim()} onClick={() => void onSave(text.trim())}>Save</button>
      </div>
    </div>
  );
}

function AboutRow({ about, onSave }: { about: string; onSave: (v: string) => Promise<void> }) {
  const [text, setText] = useState(about);
  useEffect(() => { setText(about); }, [about]);
  return (
    <div className="prof-group">
      <div className="prof-label">About you</div>
      <div className="addrow">
        <input className="addinput sm" placeholder="One line: who you are / how you work" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void onSave(text.trim()); }} />
        <button className="btn" disabled={text.trim() === about.trim()} onClick={() => void onSave(text.trim())}>Save</button>
      </div>
    </div>
  );
}

function AddRow({ placeholder, onAdd }: { placeholder: string; onAdd: (v: string) => Promise<void> }) {
  const [text, setText] = useState("");
  const go = async () => { const v = text.trim(); if (!v) return; await onAdd(v); setText(""); };
  return (
    <div className="addrow">
      <input className="addinput sm" placeholder={placeholder} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void go(); }} />
      <button className="btn" disabled={!text.trim()} onClick={() => void go()}>Add</button>
    </div>
  );
}

function AddTask({ onAdded }: { onAdded: (t: WebTask[]) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const v = text.trim();
    if (!v || busy) return;
    setBusy(true);
    try { onAdded(await api.add(v)); setText(""); } finally { setBusy(false); }
  };
  return (
    <div className="addrow">
      <input
        className="addinput"
        placeholder="Add a to-do… Otto will do what it can"
        value={text}
        disabled={busy}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
      />
      <button className="btn primary" disabled={busy || !text.trim()} onClick={() => void submit()}>{busy ? "Adding…" : "Add"}</button>
    </div>
  );
}

function Card({ task, open, onToggle, onChange, onTask }: { task: WebTask; open: boolean; onToggle: () => void; onChange: (t: WebTask[]) => void; onTask: (t: WebTask) => void }) {
  const [running, setRunning] = useState(false);
  const [stepBusy, setStepBusy] = useState<number | null>(null);
  const [failed, setFailed] = useState<number[]>([]); // steps whose auto-do errored — don't auto-retry
  const [decided, setDecided] = useState<Record<number, string>>({}); // what the user typed for a manual step
  const [showContext, setShowContext] = useState(false); // Context is hidden by default — shown only on demand
  const [sending, setSending] = useState<number | null>(null); // which sendable is being sent
  const [viewDraft, setViewDraft] = useState<number | null>(null); // which sendable's draft is expanded for review
  const [confirmIdx, setConfirmIdx] = useState<number | null>(null); // which sendable is awaiting send confirmation
  const [changeIdx, setChangeIdx] = useState<number | null>(null);   // which sendable's "what to change" box is open
  const [changeText, setChangeText] = useState("");
  const [revising, setRevising] = useState(false);
  const p = prio(task);
  const act = async (fn: () => Promise<WebTask[]>) => { onChange(await fn()); };
  // Mark a manual step done, recording what the user decided (so dependent auto-steps can use it).
  const markStepDone = (i: number) => act(() => api.stepDone(task.id, i, true, (decided[i] || "").trim() || undefined));
  const run = async () => { setRunning(true); try { onTask(await api.run(task.id)); } finally { setRunning(false); } };
  // Confirmed send (user clicked through the inline confirm) — the ONLY thing that actually sends.
  const doSend = async (i: number) => {
    if (sending != null) return; // guard against a double-send race
    setConfirmIdx(null); setSending(i);
    try { onTask(await api.sendDraft(task.id, i)); } catch { /* retried by api */ } finally { setSending(null); }
  };
  // The user declined and said what to change → re-run the task with that note so Otto revises the draft.
  const doRevise = async () => {
    const note = changeText.trim();
    if (!note || revising) return;
    setRevising(true);
    // The re-draft replaces the sendables list, so clear any open draft preview (its index may now be stale).
    try { onTask(await api.revise(task.id, note)); setChangeIdx(null); setChangeText(""); setViewDraft(null); }
    catch { /* surfaced via task state */ } finally { setRevising(false); }
  };

  const steps = task.steps || [];
  const blocked = (s: TaskStep) => s.dependsOn != null && !steps[s.dependsOn]?.done;
  // "Open example.com ↗" instead of a bare "Open ↗" — the user sees WHERE each step goes before clicking.
  const urlHost = (u?: string) => { try { return u ? new URL(u).hostname.replace(/^www\./, "") : ""; } catch { return ""; } };
  // A step can auto-run if it's automatable, unblocked, not done, not already-failed, doesn't need permission,
  // and (not a tab-open OR the extension is here to open it unattended). Tab-opens without the extension wait for a click.
  const canAuto = (s: TaskStep, i: number) => s.automatable && !s.needsPermission && !s.question && !s.done && !blocked(s) && !failed.includes(i) && (!s.url || extPresent());

  const doStep = async (i: number, answer?: string) => {
    const s = steps[i];
    if (!s || stepBusy != null) return;
    setStepBusy(i);
    try {
      // A helper link on a USER step (directions, a booking page…) just opens — the user still has to
      // do the real-world part, so only automatable page-opens self-complete.
      if (s.url) { openTab(s.url, TAB_GROUP); if (s.automatable) onChange(await api.stepDone(task.id, i, true, "Opened ↗")); }
      else { onTask(await api.runStep(task.id, i, answer)); }
    } catch { setFailed((f) => (f.includes(i) ? f : [...f, i])); } // stop auto-retrying; user can click to retry
    finally { setStepBusy(null); }
  };

  // Open ALL of a task's remaining page-steps at once, into one tab group named after the task.
  const openAllPages = async () => {
    const idxs = steps.map((s, i) => ({ s, i })).filter(({ s }) => s.url && !s.done && !blocked(s)).map(({ i }) => i);
    if (!idxs.length) return;
    openTabs(idxs.map((i) => steps[i].url!), TAB_GROUP);
    let res: WebTask[] | null = null;
    for (const i of idxs) if (steps[i].automatable) res = await api.stepDone(task.id, i, true, "Opened ↗");
    if (res) onChange(res);
  };
  const openableCount = steps.filter((s) => s.url && !s.done && !blocked(s)).length;

  // Auto-do: silently run the next automatable, unblocked step (one at a time). Manual steps + tab-opens
  // (without the extension) wait for you; completing a manual prerequisite unblocks its dependents.
  useEffect(() => {
    if (task.status !== "executed" || stepBusy != null) return;
    const i = steps.findIndex((s, idx) => canAuto(s, idx));
    if (i >= 0) void doStep(i);
  }, [task, stepBusy, failed]);

  // Auto-open documents Otto created (Doc/Sheet/Slides) once the task is done — capped per task + per
  // session, once per URL, and only with the extension (so it isn't popup-blocked). Off if the user toggled it.
  useEffect(() => {
    if (task.status !== "executed" || !autoOpenDocsOn() || !extPresent()) return;
    const room = SESSION_DOC_CAP - sessionDocsOpened;
    if (room <= 0) return;
    // Only docs we've NEVER auto-opened (persisted across reloads) — so the same tabs never reopen.
    const docs = (task.links || []).map((l) => l.url).filter((u) => DOC_RE.test(u) && !openedDocs.has(u));
    const toOpen = docs.slice(0, Math.min(room, PER_TASK_DOC_CAP));
    if (!toOpen.length) return;
    markDocsOpened(toOpen);
    sessionDocsOpened += toOpen.length;
    openTabs(toOpen, TAB_GROUP);
  }, [task.status, task.links]);

  // Bring a deep-linked card into view when it opens (e.g. landing on #/task/<id> directly).
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (open) cardRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }, [open]);

  // State classes drive the visual language: pulsing node while thinking, soft amber glow when a step
  // is waiting on the user, dormant/desaturated once handled — readable at a glance, without reading.
  const isDone = task.status === "done" || task.status === "dismissed";
  const needsYou = !isDone && task.status === "executed" &&
    (task.steps || []).some((s) => !s.done && (!s.automatable || s.needsPermission || !!s.question));
  return (
    <div ref={cardRef} className={`card ${p.cls} ${open ? "open" : ""} ${task.status === "running" ? "running" : ""} ${needsYou ? "needs-you" : ""} ${isDone ? "is-done" : ""} ${task.status === "dismissed" ? "dismissed" : ""}`}>
      <div className="card-main" onClick={onToggle}>
        <span className={`pill ${p.cls}`}>{p.label}</span>
        <div className="card-text">
          <div className="card-title">{task.title}</div>
          <div className="card-sub">{task.when && <span className="when">{task.when}</span>}{subtitle(task)}</div>
        </div>
        {task.status === "running" ? <span className="card-spin" title="Working…" />
          : task.status === "executed" && (task.steps?.length ?? 0) > 0
            ? <span className="card-prog" title="Steps done">{(task.steps || []).filter((s) => s.done).length}/{task.steps!.length}</span>
            : null}
        <span className="caret">{open ? "−" : "+"}</span>
      </div>

      {open && (
        <div className="detail">
          <section>
            <h4>What Otto did</h4>
            {task.synthesis
              ? <Bullets text={task.synthesis} />
              : <p className="muted">{task.status === "running" ? "Working on it now…" : task.status === "executed" ? "Nothing to report." : "Hasn't run yet."}</p>}
            {task.links?.length ? (
              <ul className="links artifacts">{task.links.map((l, i) => <li key={i}><a href={l.url} target="_blank" rel="noreferrer">{l.label} ↗</a></li>)}</ul>
            ) : null}
            {/* The agent drafted it — review it right here, then fire it (with a confirm). The only time anything sends. */}
            {task.sendables?.length ? (
              <div className="sendables">
                {task.sendables.map((s, i) => {
                  // Who this goes to — ALWAYS shown before the user sends (a calendar invite lists every attendee).
                  const recipients = s.app === "gcal" ? (s.attendees || []).join(", ") : (s.to || s.channel || "");
                  const noun = s.app === "gcal" ? "calendar invite" : s.app === "slack" ? "Slack message" : "email";
                  const sendIcon = "";
                  return (
                  <div key={i} className="sendable">
                    {/* The recipient is on the face of the card, not hidden behind a click — you see who before you send. */}
                    {recipients ? (
                      <div className="sendable-to">
                        <span className="sendable-to-label">{s.app === "gcal" ? "Invites" : "To"}</span>
                        <span className="sendable-to-who">{recipients}</span>
                      </div>
                    ) : null}
                    <div className="sendable-row">
                      <button className="btn xs ghost" onClick={() => setViewDraft((v) => (v === i ? null : i))}>{viewDraft === i ? "Hide details" : s.app === "gcal" ? "View event" : "View draft"}</button>
                      {s.sent
                        ? <button className="btn primary send-btn sent" disabled>Sent</button>
                        : sending === i
                          ? <button className="btn primary send-btn" disabled>Sending…</button>
                          : <button className="btn primary send-btn" onClick={() => { setChangeIdx(null); setConfirmIdx(confirmIdx === i ? null : i); }}>{`${sendIcon} ${s.label}`}</button>}
                    </div>
                    {/* Confirm step — the recipient is spelled out in full before anything sends. */}
                    {confirmIdx === i && !s.sent && sending !== i ? (
                      <div className="confirm">
                        <div className="confirm-q">Send this {noun} to <b>{recipients || "the recipient"}</b>?</div>
                        <div className="confirm-acts">
                          <button className="btn primary xs" onClick={() => void doSend(i)}>Yes, send</button>
                          <button className="btn xs" onClick={() => { setConfirmIdx(null); setChangeText(""); setChangeIdx(i); }}>No — change something</button>
                          <button className="btn xs ghost" onClick={() => setConfirmIdx(null)}>Cancel</button>
                        </div>
                      </div>
                    ) : null}
                    {/* Declined → say what to change; Otto re-drafts (updates the existing draft) and re-offers it. */}
                    {changeIdx === i && !s.sent ? (
                      <div className="confirm">
                        <div className="confirm-q">What should change before sending?</div>
                        <div className="change-row">
                          <input className="addinput sm" autoFocus disabled={revising}
                            placeholder="e.g. add my flight times, make it shorter, fix the date"
                            value={changeText} onChange={(e) => setChangeText(e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Enter") void doRevise(); }} />
                          <button className="btn primary xs" disabled={revising || !changeText.trim()} onClick={() => void doRevise()}>{revising ? "Revising…" : "Revise"}</button>
                          <button className="btn xs ghost" disabled={revising} onClick={() => { setChangeIdx(null); setChangeText(""); }}>Cancel</button>
                        </div>
                      </div>
                    ) : null}
                    {viewDraft === i ? (
                      <div className="draft">
                        {s.app === "gcal" ? (
                          <>
                            {s.summary ? <div className="draft-row"><span className="draft-label">Event</span><span>{s.summary}</span></div> : null}
                            {s.when ? <div className="draft-row"><span className="draft-label">When</span><span>{s.when}</span></div> : null}
                            {recipients ? <div className="draft-row"><span className="draft-label">Invites</span><span>{recipients}</span></div> : null}
                          </>
                        ) : (
                          <>
                            {(s.to || s.channel) ? <div className="draft-row"><span className="draft-label">To</span><span>{s.to || s.channel}</span></div> : null}
                            {s.subject ? <div className="draft-row"><span className="draft-label">Subject</span><span>{s.subject}</span></div> : null}
                            <pre className="draft-body">{s.body || s.text || "Draft is ready in Gmail — open it there to read the full text."}</pre>
                          </>
                        )}
                      </div>
                    ) : null}
                  </div>
                  );
                })}
              </div>
            ) : null}
          </section>
          {steps.length > 0 && (
          <section>
            <h4>What's left{openableCount >= 2 && <button className="btn xs ghost head-act" onClick={() => void openAllPages()}>Open all {openableCount} ↗</button>}</h4>
              <ul className="steps">
                {steps.map((s, i) => {
                  const blk = blocked(s);
                  const busyHere = stepBusy === i;
                  const gatesAnother = steps.some((o, j) => j !== i && o.dependsOn === i); // does a later step wait on this one?
                  return (
                    <li key={i} className={`step ${s.done ? "done" : ""} ${blk ? "blocked" : ""}`}>
                      {/* The mark IS the control for a needs-you step: click ○ to tick it done (no separate button). */}
                      <button
                        type="button"
                        className={`step-mark ${busyHere ? "busy" : ""} ${!s.done && !s.automatable && !blk ? "tickable" : ""}`}
                        title={s.done ? "Done — click to undo" : busyHere ? "Otto is doing this…" : blk ? "Waiting on an earlier step" : s.automatable ? (s.needsPermission ? "Needs your approval" : s.question ? "Otto needs one answer from you" : "Otto does this automatically") : "Click to mark done"}
                        disabled={busyHere || s.automatable || blk}
                        onClick={() => { if (s.automatable || blk) return; s.done ? void act(() => api.stepDone(task.id, i, false)) : void markStepDone(i); }}
                      >
                        {s.done ? "✓" : s.automatable ? (s.needsPermission ? "⊙" : s.question ? "?" : "•") : "○"}
                      </button>
                      <div className="step-body">
                        <span className="step-text">{s.text}</span>
                        {s.result ? <span className={`step-result ${s.done ? "" : "note"}`}>{s.result}</span> : null}
                        {!s.done && blk ? <span className="step-dep">waits for step {(s.dependsOn ?? 0) + 1}</span> : null}
                        {/* Otto needs ONE detail to do this step itself — tap a likely answer or type one; answering runs it. */}
                        {s.question && !s.done && !blk && !busyHere ? (
                          <div className="step-q">
                            <span className="step-q-text">{s.question}</span>
                            {s.options?.length ? (
                              <div className="step-q-opts">
                                {s.options.map((o, k) => (
                                  <button key={k} className="btn xs opt" disabled={stepBusy != null} onClick={() => void doStep(i, o)}>{o}</button>
                                ))}
                              </div>
                            ) : null}
                            <div className="step-q-free">
                              <input
                                className="step-input"
                                placeholder={s.options?.length ? "Or type your own answer…" : "Type your answer — Otto takes it from there"}
                                value={decided[i] || ""}
                                disabled={stepBusy != null}
                                onChange={(e) => setDecided((d) => ({ ...d, [i]: e.target.value }))}
                                onKeyDown={(e) => { if (e.key === "Enter" && (decided[i] || "").trim()) void doStep(i, decided[i].trim()); }}
                              />
                              <button className="btn xs primary" disabled={stepBusy != null || !(decided[i] || "").trim()} onClick={() => void doStep(i, decided[i].trim())}>Answer</button>
                            </div>
                          </div>
                        ) : null}
                        {/* "What did you decide?" only when this step GATES a later one — then it feeds that next step. */}
                        {gatesAnother && !s.done && !blk && !s.automatable ? (
                          <input
                            className="step-input"
                            placeholder="What did you decide? (feeds the next step)"
                            value={decided[i] || ""}
                            onChange={(e) => setDecided((d) => ({ ...d, [i]: e.target.value }))}
                            onKeyDown={(e) => { if (e.key === "Enter") void markStepDone(i); }}
                          />
                        ) : null}
                      </div>
                      <div className="step-act">
                        {/* A URL step keeps its "Open ↗" link ALWAYS — even after Otto opened it — so the page
                            stays reachable from the task. Done/blocked: just reopen the tab; otherwise open + mark done. */}
                        {busyHere ? <span className="muted small">Working…</span>
                          : s.url ? <button className="btn xs ghost" title={s.url} onClick={() => (s.done || blk) ? openTab(s.url!, TAB_GROUP) : void doStep(i)}>Open {urlHost(s.url)} ↗</button>
                          : s.done || blk ? null
                          : s.automatable ? (s.needsPermission ? <button className="btn xs primary" onClick={() => void doStep(i)}>Approve & Run</button> : s.question ? null : <button className="btn xs ghost" onClick={() => void doStep(i)}>Auto-do</button>)
                          : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
          </section>
          )}
          <button className="ctx-toggle" onClick={() => setShowContext((v) => !v)}>{showContext ? "Hide context" : "Show context"}</button>
          {showContext && (
            <section className="ctx">
              <div className="ctx-src">{sourceLabel(task.source)}</div>
              <Bullets text={task.context || task.why} />
              {task.evidence?.length ? (
                <ul className="links src-links">{task.evidence.map((l, i) => <li key={i}><a href={l.url} target="_blank" rel="noreferrer">{l.label} ↗</a></li>)}</ul>
              ) : null}
            </section>
          )}
          <div className="actions">
            {task.status === "executed" ? (
              <>
                <button className="btn primary" title="Looks good — mark this handled" onClick={() => void act(() => api.confirm(task.id))}>Looks good</button>
                <div className="actions-rest">
                  <button className="btn xs ghost" disabled={running} title="Have Otto do it over" onClick={() => void run()}>{running ? "Working…" : "Redo"}</button>
                  <button className="btn xs ghost" title="Remove this task" onClick={() => void act(() => api.dismiss(task.id))}>Dismiss</button>
                </div>
              </>
            ) : (
              <>
                {task.autoRan ? (
                  <button className="btn primary" disabled={running} onClick={() => void run()}>{running ? "Working…" : "Retry"}</button>
                ) : (
                  <button className="btn primary" disabled>{running ? "Working…" : "Preparing…"}</button>
                )}
                <div className="actions-rest"><button className="btn xs ghost" title="Remove this task" onClick={() => void act(() => api.dismiss(task.id))}>Dismiss</button></div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
