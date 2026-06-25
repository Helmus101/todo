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
    return n ? `Prepared — ${n} thing${n > 1 ? "s" : ""} need${n > 1 ? "" : "s"} you · tap to review` : "Done for you · tap to review & confirm";
  }
  return t.why;
}

// Open a URL in a new tab. Prefers the Weave Chrome extension (web/extension/) — it sets a DOM flag and
// relays postMessage to chrome.tabs.create, so tabs can open UNATTENDED during auto-do. Without it, falls
// back to window.open (works on a user click).
const TAB_GROUP = "Weave"; // all tabs Weave opens go into this one named group
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

/** Render context/synthesis as a clean bullet list (one bullet per line; leading -/•/* stripped). Full
 *  text always shown — never truncated. Falls back to a single line if there's just one. */
function Bullets({ text }: { text: string }) {
  const items = (text || "").split("\n").map((l) => l.replace(/^\s*[-•*]\s*/, "").trim()).filter(Boolean);
  if (items.length <= 1) return <p>{items[0] || text}</p>;
  return <ul className="bullets">{items.map((b, i) => <li key={i}>{b}</li>)}</ul>;
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
  const generatedOnce = useRef(false);
  const inflight = useRef<Set<string>>(new Set()); // ids currently auto-running (bounded concurrency)
  const attempts = useRef<Map<string, number>>(new Map()); // per-task auto-run attempts (capped retry)
  const RUN_LIMIT = 2;            // run a couple at once — enough to keep moving, gentle on the dev server
  const RUN_TIMEOUT_MS = 120_000; // a stuck run can never wedge the whole queue

  const loadStatus = useCallback(async () => { try { setStatus(await api.status()); } catch { /* keep last */ } }, []);

  // Persist the signed-in state so a returning user skips the login flash (reconciled on next load).
  useEffect(() => {
    try { status ? localStorage.setItem("weave-status", JSON.stringify(status)) : localStorage.removeItem("weave-status"); } catch { /* ignore */ }
  }, [status]);

  // Retry status until the backend is reachable (tsx dev-server boot race) — don't get stuck on the spinner.
  useEffect(() => {
    let stop = false, tries = 0;
    const tick = async () => {
      if (stop) return;
      try { const s = await api.status(); if (!stop) setStatus(s); }
      catch { if (!stop && tries++ < 30) setTimeout(tick, 1000); }
    };
    void tick();
    return () => { stop = true; };
  }, []);

  const connected = !!status?.googleConnected;

  // Once Google is connected: load tasks; first time (if empty) auto-generate.
  useEffect(() => {
    if (!connected) return;
    void (async () => {
      const t = await api.tasks().catch(() => [] as WebTask[]);
      setTasks(t);
      if (!generatedOnce.current && t.length === 0 && status?.aiReady) {
        generatedOnce.current = true;
        setBusy(true); setNote("");
        try { setTasks(await api.generate()); }
        catch (e: any) { setNote(`Couldn't generate tasks: ${e?.message || "error"}`); }
        finally { setBusy(false); }
      }
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
      const timeout = new Promise<WebTask>((_, rej) => setTimeout(() => rej(new Error("timeout")), RUN_TIMEOUT_MS));
      Promise.race([api.run(task.id), timeout])
        .then((u) => { if (u && u.id) { attempts.current.delete(u.id); setTasks((prev) => prev.map((t) => (t.id === u.id ? u : t))); } })
        .catch(() => {
          // Pause this task now. A failure is often transient (the dev server restarted mid-run → socket
          // hang up). Retry a couple of times with a short delay; only give up (stay paused, user can hit
          // Run again) after that, so a real fault doesn't loop forever.
          const n = (attempts.current.get(task.id) || 0) + 1;
          attempts.current.set(task.id, n);
          setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, status: "ready", autoRan: true } : t)));
          if (n < 3) setTimeout(() => setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, autoRan: false } : t))), 5000);
        })
        .finally(() => { inflight.current.delete(task.id); });
    }
  }, [tasks, connected]);

  // Auto-generate fresh to-dos every 10 minutes while the app is open.
  useEffect(() => {
    if (!connected || !status?.aiReady) return;
    const id = setInterval(() => { void api.generate().then(setTasks).catch(() => {}); }, 10 * 60 * 1000);
    return () => clearInterval(id);
  }, [connected, status?.aiReady]);

  const generate = async () => {
    setBusy(true); setNote("");
    try { const t = await api.generate(); setTasks(t); if (!t.length) setNote("Nothing actionable in your recent inbox + calendar right now."); }
    catch (e: any) { setNote(`Couldn't generate tasks: ${e?.message || "error"}`); }
    finally { setBusy(false); }
  };
  const signOut = async () => { await api.logout(); setTasks([]); generatedOnce.current = false; navigate(""); void loadStatus(); };

  // Signed in, the dashboard lives at /tasks. Redirect the bare "/" there (landing only shows signed-OUT).
  useEffect(() => { if (status?.loggedIn && route === "") navigate("tasks"); }, [status?.loggedIn, route]);

  if (!status) return <div className="screen"><div className="spinner" /></div>;
  if (!status.loggedIn) {
    return route === "login" || route === "signup"
      ? <LoginPage status={status} onDone={async () => { await loadStatus(); navigate("tasks"); }} initialMode={route === "signup" ? "signup" : "login"} />
      : <Landing />;
  }

  const live = tasks.filter((t) => t.status !== "done" && t.status !== "dismissed").sort((a, b) => b.score - a.score);
  const working = tasks.filter((t) => t.status === "running").length;
  const handled = tasks.filter((t) => t.status === "done").length;
  const openId = route.startsWith("task/") ? route.slice(5) : null; // the deep-linked task, if any

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">Weave</div>
        <nav className="tabs">
          <a className={`tab ${route === "" || route === "tasks" || route.startsWith("task/") ? "active" : ""}`} href="/tasks">Tasks</a>
          <a className={`tab ${route === "chat" ? "active" : ""}`} href="/chat">Chat</a>
          <a className={`tab ${route === "settings" ? "active" : ""}`} href="/settings">Settings</a>
        </nav>
        <div className="spacer" />
        {(route === "" || route === "tasks" || route.startsWith("task/")) && status.googleConnected && <button className="btn ghost" disabled={busy} onClick={() => void generate()}>{busy ? "Finding…" : "↻ Refresh"}</button>}
      </header>

      {route === "settings" ? (
        <SettingsPage status={status} onSignOut={signOut} onChanged={loadStatus} />
      ) : route === "chat" ? (
        <ChatPage />
      ) : !status.googleConnected ? (
        <main className="list-wrap"><ConnectCard status={status} /></main>
      ) : (
        <main className="list-wrap">
          <div className="dash-head">
            <h1 className="dash-greeting">{GREETING()}.</h1>
            <div className="dash-stats">
              <span><b>{live.length}</b> on your plate</span>
              {working ? <span className="dash-run"><b>{working}</b> running<span className="mini" /></span> : null}
              {handled ? <span><b>{handled}</b> handled</span> : null}
            </div>
          </div>
          <AddTask onAdded={setTasks} />
          {/* If a deep link points at a task that's already handled (not in the live list), surface it so the URL still resolves. */}
          {(() => {
            const shown = openId && !live.some((t) => t.id === openId)
              ? [...live, ...tasks.filter((t) => t.id === openId)]
              : live;
            return shown.length === 0
              ? <div className="empty">{busy ? "Looking through your inbox, calendar & Drive…" : (note || "You're all clear. New mail or meetings show up here.")}</div>
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
          {note && live.length > 0 && <div className="empty" style={{ padding: "10px 16px" }}>{note}</div>}
        </main>
      )}
    </div>
  );
}

/** A connect-Gmail call to action — shown on the dashboard until Gmail is linked (via Composio, in Settings). */
function ConnectCard({ status }: { status: ConnectionStatus }) {
  return (
    <div className="connect-card">
      <h2>Connect Gmail to begin</h2>
      <p>Weave reads your inbox, calendar and Drive so it can do your to-dos. It only ever creates <b>drafts</b> and <b>docs</b> — never sends without you.</p>
      {!status.googleConfigured && <div className="warn">Integrations aren't configured on the server (COMPOSIO_API_KEY).</div>}
      {!status.aiReady && <div className="warn">Server is missing ANTHROPIC_API_KEY — task generation is disabled.</div>}
      <a className="btn primary big" href="/settings">Connect in Settings</a>
    </div>
  );
}

/** The Settings PAGE (route /settings): account, ALL app connections (Composio — incl. Google), the
 *  person-profile editor, and exactly what Weave will/won't do. */
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
        <p className="settings-hint">Connect the apps you live in — start with <b>Gmail</b> and <b>Google Calendar</b> (that's what your to-dos are built from). Weave can read them and do the reversible work (draft a reply, create a doc, add a task). It can <b>never send, post, publish, or delete</b> on its own — those stay your call.</p>
        <Integrations onChanged={onChanged} />
      </section>

      <section className="settings-sec">
        <h3>Who Weave thinks you are</h3>
        <p className="settings-hint">Weave fills this in as it works — and it shapes how it chooses and does your to-dos. Edit anything.</p>
        <ProfileEditor />
      </section>

      <section className="settings-sec">
        <h3>What Weave can do</h3>
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

  const disconnect = async (key: string) => {
    if (busy) return;
    setBusy(key);
    try { await api.disconnectIntegration(key); await load(); } finally { setBusy(""); }
  };

  if (items === null) return <div className="muted small">Loading integrations…</div>;
  if (!ready) return <div className="warn">Integrations need <b>COMPOSIO_API_KEY</b> set on the server (it's in Weave's root <code>.env</code>). Restart the server after adding it.</div>;

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
                <div className="int-info">
                  <div className="int-name">{i.name}{i.connected && <span className="int-dot" title="Connected" />}</div>
                  <div className="int-blurb">{i.blurb}</div>
                </div>
                {i.connected
                  ? <button className="btn xs ghost" disabled={busy === i.key} onClick={() => void disconnect(i.key)}>{busy === i.key ? "…" : "Disconnect"}</button>
                  : <a className="btn xs" href={`/integrations/${i.key}/connect`}>Connect</a>}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Chat PAGE (route /chat): a Claude-backed assistant that can search the web (DuckDuckGo fallback) and
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
            <h2>Ask Weave anything.</h2>
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
          placeholder="Message Weave…"
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
function LoginPage({ status, onDone, initialMode }: { status: ConnectionStatus; onDone: () => void; initialMode: "login" | "signup" }) {
  const [mode, setMode] = useState<"login" | "signup">(initialMode);
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (busy || !email.trim() || !pw) return;
    setBusy(true); setErr("");
    const r = mode === "signup" ? await api.signup(email.trim(), pw) : await api.login(email.trim(), pw);
    setBusy(false);
    if (r.ok) onDone(); else setErr(r.error || "Something went wrong.");
  };
  return (
    <div className="login-page">
      <header className="landing-nav"><a className="brand" href="/">Weave</a></header>
      <main className="login-main">
        <div className="login-card">
          <h1 className="login-title">{mode === "signup" ? "Create your account" : "Welcome back"}</h1>
          <p className="login-sub">{mode === "signup" ? "Two fields and you're in — connect Google next." : "Log in to pick up where Weave left off."}</p>
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
      <header className="landing-nav"><span className="brand">Weave</span><a className="btn ghost" href="/login">Log in</a></header>
      <main className="hero">
        <h1 className="hero-title">The to-do list that <em>does itself</em>.</h1>
        <p className="hero-sub">Weave reads your inbox, calendar and Drive — then quietly does the work. It drafts the replies, preps the docs, and clears your list before you have to ask.</p>
        <div className="hero-cta">
          <a className="btn primary big" href="/signup">Get started — it's free</a>
          <a className="btn big" href="/login">Log in</a>
        </div>
        <div className="fineprint">Only ever drafts &amp; docs — Weave never sends anything without you.</div>
      </main>

      <section className="landing-sec">
        <h2>How it works</h2>
        <p className="lead">Connect once. From then on Weave watches the things that actually need you and quietly gets ahead of them.</p>
        <div className="how">
          <div className="how-step"><div className="n">01</div><h3>It reads your world</h3><p>Inbox, calendar and Drive — pulling out the few things that genuinely need a reply, a decision, or prep.</p></div>
          <div className="how-step"><div className="n">02</div><h3>It does the work</h3><p>Drafts the reply in your voice, builds the doc, gathers the context — then shows you exactly what it did.</p></div>
          <div className="how-step"><div className="n">03</div><h3>You just confirm</h3><p>Review the draft in the app and send with one tap. Anything only you can do is laid out as a short checklist.</p></div>
        </div>
      </section>

      <section className="landing-sec">
        <h2>Built to be trusted</h2>
        <div className="features">
          <div className="feature"><div><h3>Drafts, never sends</h3><p>Every email is a draft you read in the app. Nothing leaves without your explicit confirmation.</p></div></div>
          <div className="feature"><div><h3>Learns who you are</h3><p>It remembers your people, projects and preferences, so its work sounds like you — and gets sharper over time.</p></div></div>
          <div className="feature"><div><h3>Your account, your data</h3><p>Saved privately to your account. Read-only access to mail and Drive; it can create drafts and docs, nothing more.</p></div></div>
          <div className="feature"><div><h3>Clears itself</h3><p>Reversible work happens automatically in the background. You open the app to a list that's already half-done.</p></div></div>
        </div>
      </section>

      <div className="landing-foot">Weave — the to-do list that does itself.</div>
    </div>
  );
}

const SOURCE: Record<string, string> = { gmail: "✉ Gmail", calendar: "📅 Calendar", manual: "✎ You" };

/** The person-profile editor (lives in the Settings page): about + preferences + people + projects.
 *  Weave fills it in as it works; it's injected into how tasks are chosen + done. Always expanded here. */
function ProfileEditor() {
  const [p, setP] = useState<Profile | null>(null);
  useEffect(() => { void api.profile().then(setP).catch(() => setP(null)); }, []);
  if (!p) return <p className="muted small">Loading…</p>;
  const count = (p.about ? 1 : 0) + p.preferences.length + p.people.length + p.projects.length;
  const lists = [
    { key: "preference" as const, label: "Preferences", items: p.preferences },
    { key: "person" as const, label: "People", items: p.people },
    { key: "project" as const, label: "Projects", items: p.projects },
  ];
  return (
    <div className="memory-body">
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
      {count === 0 && <div className="muted small">Empty for now — Weave fills this in as it works, or add things here.</div>}
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
        placeholder="Add a to-do… Weave will do what it can"
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
  const p = prio(task);
  const act = async (fn: () => Promise<WebTask[]>) => { onChange(await fn()); };
  // Mark a manual step done, recording what the user decided (so dependent auto-steps can use it).
  const markStepDone = (i: number) => act(() => api.stepDone(task.id, i, true, (decided[i] || "").trim() || undefined));
  const run = async () => { setRunning(true); try { onTask(await api.run(task.id)); } finally { setRunning(false); } };

  const steps = task.steps || [];
  const blocked = (s: TaskStep) => s.dependsOn != null && !steps[s.dependsOn]?.done;
  // A step can auto-run if it's automatable, unblocked, not done, not already-failed, and (not a tab-open
  // OR the extension is here to open it unattended). Tab-opens without the extension wait for a click.
  const canAuto = (s: TaskStep, i: number) => s.automatable && !s.done && !blocked(s) && !failed.includes(i) && (!s.url || extPresent());

  const doStep = async (i: number) => {
    const s = steps[i];
    if (!s || stepBusy != null) return;
    setStepBusy(i);
    try {
      if (s.url) { openTab(s.url, TAB_GROUP); onChange(await api.stepDone(task.id, i, true, "Opened ↗")); }
      else { onTask(await api.runStep(task.id, i)); }
    } catch { setFailed((f) => (f.includes(i) ? f : [...f, i])); } // stop auto-retrying; user can click to retry
    finally { setStepBusy(null); }
  };

  // Open ALL of a task's remaining page-steps at once, into one tab group named after the task.
  const openAllPages = async () => {
    const idxs = steps.map((s, i) => ({ s, i })).filter(({ s }) => s.url && !s.done && !blocked(s)).map(({ i }) => i);
    if (!idxs.length) return;
    openTabs(idxs.map((i) => steps[i].url!), TAB_GROUP);
    let res: WebTask[] | null = null;
    for (const i of idxs) res = await api.stepDone(task.id, i, true, "Opened ↗");
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

  // Bring a deep-linked card into view when it opens (e.g. landing on #/task/<id> directly).
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (open) cardRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }, [open]);

  return (
    <div ref={cardRef} className={`card ${p.cls} ${open ? "open" : ""} ${task.status === "running" ? "running" : ""}`}>
      <div className="card-main" onClick={onToggle}>
        <span className={`pill ${p.cls}`}>{p.label}</span>
        <div className="card-text">
          <div className="card-title">{task.title}{task.status === "executed" && <span className="tick">✓</span>}</div>
          <div className="card-sub">{task.when && <span className="when">{task.when}</span>}{subtitle(task)}</div>
        </div>
        <span className="caret">{open ? "▾" : "▸"}</span>
      </div>

      {open && (
        <div className="detail">
          <section>
            <h4>Context <span className="src">{SOURCE[task.source] || task.source}</span></h4>
            <Bullets text={task.context || task.why} />
            {task.evidence?.length ? (
              <ul className="links src-links">{task.evidence.map((l, i) => <li key={i}><a href={l.url} target="_blank" rel="noreferrer">{l.label} ↗</a></li>)}</ul>
            ) : null}
          </section>
          <section>
            <h4>What I've done</h4>
            {task.synthesis ? <Bullets text={task.synthesis} /> : <p className="muted">{task.status === "running" ? "Working on it now…" : "Runs automatically — nothing yet."}</p>}
            {task.links?.length ? (
              <ul className="links">{task.links.map((l, i) => <li key={i}><a href={l.url} target="_blank" rel="noreferrer">{l.label} ↗</a></li>)}</ul>
            ) : null}
          </section>
          <section>
            <h4>Steps {openableCount >= 2 && <button className="btn xs ghost head-act" onClick={() => void openAllPages()}>Open all {openableCount} pages ↗</button>}</h4>
            {steps.length ? (
              <ul className="steps">
                {steps.map((s, i) => {
                  const blk = blocked(s);
                  const busyHere = stepBusy === i;
                  return (
                    <li key={i} className={`step ${s.done ? "done" : ""} ${blk ? "blocked" : ""}`}>
                      <span className={`step-mark ${busyHere ? "busy" : ""}`} title={s.done ? "Done" : busyHere ? "Weave is doing this…" : s.automatable ? "Weave can do this" : "Needs you"}>
                        {s.done ? "✓" : s.automatable ? "⚡" : "○"}
                      </span>
                      <div className="step-body">
                        <span className="step-text">{s.text}</span>
                        {s.done && s.result ? <span className="step-result">{s.result}</span> : null}
                        {!s.done && blk ? <span className="step-dep">waits for step {(s.dependsOn ?? 0) + 1}</span> : null}
                        {/* Needs-you step: type what you decided (optional). Saved as the step's result,
                            and fed to any dependent step Weave auto-runs next. */}
                        {!s.done && !blk && !s.automatable ? (
                          <input
                            className="step-input"
                            placeholder="What did you decide? (optional)"
                            value={decided[i] || ""}
                            onChange={(e) => setDecided((d) => ({ ...d, [i]: e.target.value }))}
                            onKeyDown={(e) => { if (e.key === "Enter") void markStepDone(i); }}
                          />
                        ) : null}
                      </div>
                      <div className="step-act">
                        {s.done ? null
                          : busyHere ? <span className="muted small">Working…</span>
                          : blk ? null
                          : s.automatable
                            ? <button className="btn xs" onClick={() => void doStep(i)}>{s.url ? "Open ↗" : "Auto-do"}</button>
                            : <>
                                {s.url ? <button className="btn xs ghost" onClick={() => void doStep(i)}>Open ↗</button> : null}
                                <button className="btn xs" onClick={() => void markStepDone(i)}>Done</button>
                              </>}
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : <p className="muted">{task.status === "executed" ? "Nothing left — just confirm." : "Steps appear once it runs."}</p>}
          </section>
          <div className="actions">
            {task.status === "executed" ? (
              <>
                <div className="actions-hint">
                  ⚡ steps run themselves; ○ steps need you. Anything irreversible (sending, posting) is yours to do — Weave never does it on its own. Confirm when it's all handled.
                </div>
                <button className="btn primary" title="Looks good — mark this handled" onClick={() => void act(() => api.confirm(task.id))}>Confirm</button>
                <button className="btn" disabled={running} title="Have Weave do it over" onClick={() => void run()}>{running ? "Working…" : "↻ Run again"}</button>
                <button className="btn ghost" title="Not right — clear it and re-surface" onClick={() => void act(() => api.reject(task.id))}>Reject</button>
                <button className="btn ghost" title="Remove this task" onClick={() => void act(() => api.dismiss(task.id))}>Dismiss</button>
              </>
            ) : (
              <>
                <button className="btn primary" disabled={running} onClick={() => void run()}>{running ? "Working…" : "Do it now"}</button>
                <button className="btn ghost" title="Remove this task" onClick={() => void act(() => api.dismiss(task.id))}>Dismiss</button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
