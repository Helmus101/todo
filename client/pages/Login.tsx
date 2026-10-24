import { useState } from "react";
import type { ConnectionStatus } from "../../shared/types.ts";
import { api } from "../api.ts";
import { Logo } from "../appShared.tsx";

/** Dedicated login / sign-up PAGE (routes /login and /signup). Its own clean, centered card. */
export function LoginPage({ status, lang, onLangChange, onDone, initialMode }: { status: ConnectionStatus; lang: "fr" | "en"; onLangChange: (v: "fr" | "en") => void; onDone: (isNew?: boolean) => void; initialMode: "login" | "signup" | "reset" }) {
  const en = lang === "en";
  const L = (fr: string, e: string) => (e);
  const [mode, setMode] = useState<"login" | "signup" | "forgot" | "reset">(initialMode);
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [consent, setConsent] = useState(false);
  const [isChildAccount, setIsChildAccount] = useState(false);
  const [birthYear, setBirthYear] = useState("");
  const [parentalConsent, setParentalConsent] = useState(false);
  const [err, setErr] = useState(() => (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("error") === "google" ? "Google sign-in didn't work. Try again, or use your email." : ""));
  const [busy, setBusy] = useState(false);
  // The reset link's token lives in the URL's query string, which the app's own client-side router
  // (routeOf/navigate, above) deliberately drops — read it directly off the page's FIRST load instead of
  // through the route state. A reset link opened with no token, or an already-used/expired one, still shows
  // the form; the actual validation happens server-side when they submit (resetToken's error covers both).
  const [resetToken] = useState(() => new URLSearchParams(window.location.search).get("token") || "");
  const [resetSent, setResetSent] = useState(false);
  const [resetDone, setResetDone] = useState(false);
  const submit = async () => {
    if (busy) return;
    if (mode === "forgot") {
      if (!email.trim()) return;
      setBusy(true); setErr("");
      try {
        await api.forgotPassword(email.trim(), lang);
        setResetSent(true); // always show the same "check your email" outcome — never reveal whether the account exists
      } catch {
        setErr("Couldn't reach the server. Check your connection and try again.");
      } finally { setBusy(false); }
      return;
    }
    if (mode === "reset") {
      if (!pw) return;
      setBusy(true); setErr("");
      try {
        const r = await api.resetPassword(resetToken, pw);
        if (r.ok) { setResetDone(true); setTimeout(() => onDone(false), 1200); }
        else setErr(r.error || "Something went wrong.");
      } catch {
        setErr("Couldn't reach the server. Check your connection and try again.");
      } finally { setBusy(false); }
      return;
    }
    if (!email.trim() || !pw || (mode === "signup" && !consent)) return;
    if (mode === "signup" && isChildAccount && (!birthYear || !parentalConsent)) return;
    setBusy(true); setErr("");
    try {
      const r = mode === "signup" 
        ? await api.signup(email.trim(), pw, consent, isChildAccount, birthYear ? parseInt(birthYear) : undefined, parentalConsent) 
        : await api.login(email.trim(), pw, "en");
      if (r.ok) onDone(mode === "signup"); else setErr(r.error || "Something went wrong.");
    } catch {
      setErr("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };
  // The two main modes use the prototype's auth copy verbatim (login "You're back. Let's work." · signup "A clearer
  // day starts here."); forgot/reset keep their own explanatory copy — the prototype doesn't design those
  // states. French adapted through L() as everywhere else.
  const titles: Record<typeof mode, string> = {
    signup: "Stop guessing. Start understanding.",
    login: "Back to work.",
    forgot: "Locked out? Fixed in a minute.",
    reset: "Pick a new password.",
  };
  const subs: Record<typeof mode, string> = {
    signup: "One tutor. Zero shortcuts.",
    login: "Pick up exactly where you left off.",
    forgot: "We'll email you a link to pick a new one.",
    reset: "This link only works once.",
  };
  return (
    <div className="login-page">
      {/* Same nav chrome as the landing page (landing-nav-framer) — the prototype's public pages share
          one shell: lowercase "otto" wordmark left, language toggle right. */}
      <header className="landing-nav-framer">
        <a className="brand-framer" href="/"><Logo size={20} /> <span className="brand-name-framer">otto</span></a>
      </header>
      <main className="login-main">
        <div className="login-card">
          <h1 className="login-title">{titles[mode]}</h1>
          <p className="login-sub">{subs[mode]}</p>
          {/* "Supabase"/an env-var name means nothing to a student — say what's actually broken instead. */}
          {!status.cloud && <div className="warn">{"Accounts aren't set up on this server yet."}</div>}
          {mode === "forgot" && resetSent ? (
            <p className="settings-hint">{"If an account exists with that address, an email with a reset link just went out."}</p>
          ) : mode === "reset" && resetDone ? (
            <p className="settings-hint">{"Password updated — logging you in…"}</p>
          ) : (
            <>
              {mode !== "reset" && (
                <label className="field"><span>{"Email"}</span>
                  <input className="addinput" type="email" autoComplete="email" placeholder={"you@email.com"} value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
                </label>
              )}
              {mode !== "forgot" && (
                <label className="field"><span>{mode === "reset" ? "New password" : "Password"}</span>
                  <input className="addinput" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} placeholder={"At least 8 characters"} value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void submit(); }} autoFocus={mode === "reset"} />
                </label>
              )}
              {/* RGPD Art.8: under-15s need a parent to set the account up (see Privacy Policy) — a required,
                  recorded checkbox instead of the previous text-only claim with no actual signal captured. */}
              {mode === "signup" && (
                <>
                  <label className="field-check">
                    <input type="checkbox" checked={isChildAccount} onChange={(e) => setIsChildAccount(e.target.checked)} />
                    <span>{"This is a child account (under 15)"}</span>
                  </label>
                  {isChildAccount && (
                    <>
                      <label className="field"><span>{"Birth year"}</span>
                        <input className="addinput" type="number" placeholder="2010" value={birthYear} onChange={(e) => setBirthYear(e.target.value)} />
                      </label>
                      <label className="field-check">
                        <input type="checkbox" checked={parentalConsent} onChange={(e) => setParentalConsent(e.target.checked)} />
                        <span>{"As a parent, I consent to this account creation."}</span>
                      </label>
                    </>
                  )}
                  {!isChildAccount && (
                    <label className="field-check">
                      <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                      <span>{"I'm 15 or older, or a parent set this account up for me."}</span>
                    </label>
                  )}
                </>
              )}
              {err && <div className="autherr">{err}</div>}
              <button className="btn primary big" disabled={busy || (mode === "forgot" ? !email.trim() : mode === "reset" ? !pw : !email.trim() || !pw || (mode === "signup" && !consent))} onClick={() => void submit()}>
                {busy ? "…" : mode === "signup" ? "Create account" : mode === "forgot" ? "Send link" : mode === "reset" ? "Change password" : "Log in"}
              </button>
            </>
          )}
          {(mode === "login" || mode === "signup") && (
            <>
              <div className="login-or" aria-hidden="true">{"or"}</div>
              {/* A full page navigation: Google sign-in runs through Supabase and comes back to /auth/google/callback. */}
              <a className="google-btn" href="/auth/google">
                <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17.1z"/><path fill="#FBBC05" d="M10.5 28.7a14.5 14.5 0 0 1 0-9.4l-7.9-6.1a24 24 0 0 0 0 21.6l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2 1.4-4.7 2.3-8.5 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z"/></svg>
                <span>{"Continue with Google"}</span>
              </a>
              {mode === "signup" && <p className="login-legal">{"By continuing with Google you confirm you're 15 or older, or that a parent set this account up for you."}</p>}
            </>
          )}
          {mode === "login" && (
            <button className="btn ghost" onClick={() => { setMode("forgot"); setErr(""); setResetSent(false); }}>{"Forgot password?"}</button>
          )}
          {(mode === "login" || mode === "signup") && (
            <button className="btn ghost" onClick={() => { setMode((m) => (m === "signup" ? "login" : "signup")); setErr(""); }}>
              {mode === "signup" ? "Have an account? Log in" : "New here? Create an account"}
            </button>
          )}
          {mode === "forgot" && (
            <button className="btn ghost" onClick={() => { setMode("login"); setErr(""); setResetSent(false); }}>{"← Back to login"}</button>
          )}
          <a className="login-back" href="/">{"← Back to home"}</a>
          {/* target="_blank" deliberately — these would otherwise fall through this file's own SPA router
              (usePathRoute's click handler) which swaps the ENTIRE route to /terms or /privacy, unmounting
              this form and losing every typed field (email/password/consent/child-account fields) with no
              way back except restarting from scratch. Opening in a new tab keeps the signup form alive in
              THIS tab while the policy opens in its own — reported live as a signup-abandonment risk. */}
          <div className="login-legal">{"By continuing you agree to our "}<a href="/terms" target="_blank" rel="noopener">{"Terms"}</a> {"&"} <a href="/privacy" target="_blank" rel="noopener">{"Privacy Policy"}</a>.</div>
          <div className="login-copyright">© 2026 Otto</div>
        </div>
      </main>
    </div>
  );
}
