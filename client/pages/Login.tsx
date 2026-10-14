import { useState } from "react";
import type { ConnectionStatus } from "../../shared/types.ts";
import { api } from "../api.ts";
import { Logo } from "../appShared.tsx";

/** Dedicated login / sign-up PAGE (routes /login and /signup). Its own clean, centered card. */
export function LoginPage({ status, lang, onLangChange, onDone, initialMode }: { status: ConnectionStatus; lang: "fr" | "en"; onLangChange: (v: "fr" | "en") => void; onDone: (isNew?: boolean) => void; initialMode: "login" | "signup" | "reset" }) {
  const en = lang === "en";
  const L = (fr: string, e: string) => (en ? e : fr);
  const [mode, setMode] = useState<"login" | "signup" | "forgot" | "reset">(initialMode);
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [consent, setConsent] = useState(false);
  const [isChildAccount, setIsChildAccount] = useState(false);
  const [birthYear, setBirthYear] = useState("");
  const [parentalConsent, setParentalConsent] = useState(false);
  const [err, setErr] = useState("");
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
        setErr(L("Impossible de contacter le serveur. Vérifie ta connexion et réessaie.", "Couldn't reach the server. Check your connection and try again."));
      } finally { setBusy(false); }
      return;
    }
    if (mode === "reset") {
      if (!pw) return;
      setBusy(true); setErr("");
      try {
        const r = await api.resetPassword(resetToken, pw);
        if (r.ok) { setResetDone(true); setTimeout(() => onDone(false), 1200); }
        else setErr(r.error || L("Une erreur est survenue.", "Something went wrong."));
      } catch {
        setErr(L("Impossible de contacter le serveur. Vérifie ta connexion et réessaie.", "Couldn't reach the server. Check your connection and try again."));
      } finally { setBusy(false); }
      return;
    }
    if (!email.trim() || !pw || (mode === "signup" && !consent)) return;
    if (mode === "signup" && isChildAccount && (!birthYear || !parentalConsent)) return;
    setBusy(true); setErr("");
    try {
      const r = mode === "signup" 
        ? await api.signup(email.trim(), pw, consent, isChildAccount, birthYear ? parseInt(birthYear) : undefined, parentalConsent) 
        : await api.login(email.trim(), pw, en ? "en" : "fr");
      if (r.ok) onDone(mode === "signup"); else setErr(r.error || L("Une erreur est survenue.", "Something went wrong."));
    } catch {
      setErr(L("Impossible de contacter le serveur. Vérifie ta connexion et réessaie.", "Couldn't reach the server. Check your connection and try again."));
    } finally {
      setBusy(false);
    }
  };
  // The two main modes use the prototype's auth copy verbatim (login "You're back. Let's work." · signup "A clearer
  // day starts here."); forgot/reset keep their own explanatory copy — the prototype doesn't design those
  // states. French adapted through L() as everywhere else.
  const titles: Record<typeof mode, string> = {
    signup: L("Une journée plus claire commence ici.", "A clearer day starts here."),
    login: L("Tu es de retour. Au travail.", "You're back. Let's work."),
    forgot: L("Mot de passe oublié", "Forgot password"),
    reset: L("Choisis un nouveau mot de passe", "Choose a new password"),
  };
  const subs: Record<typeof mode, string> = {
    signup: L("Un agenda qui s'organise. Un tuteur qui t'explique.", "Meet your planner. Find your tutor."),
    login: L("Un peu de clarté t'attend.", "A little clarity is waiting for you."),
    forgot: L("On t'envoie un lien pour en choisir un nouveau.", "We'll email you a link to pick a new one."),
    reset: L("Ce lien ne fonctionne qu'une seule fois.", "This link only works once."),
  };
  return (
    <div className="login-page">
      {/* Same nav chrome as the landing page (landing-nav-framer) — the prototype's public pages share
          one shell: lowercase "otto" wordmark left, language toggle right. */}
      <header className="landing-nav-framer">
        <a className="brand-framer" href="/"><Logo size={20} /> <span className="brand-name-framer">otto</span></a>
        <button type="button" className="lang-toggle-framer" onClick={() => onLangChange(en ? "fr" : "en")} aria-label={en ? "Switch language" : "Changer de langue"}>{en ? "FR" : "EN"}</button>
      </header>
      <main className="login-main">
        <div className="login-card">
          <h1 className="login-title">{titles[mode]}</h1>
          <p className="login-sub">{subs[mode]}</p>
          {/* "Supabase"/an env-var name means nothing to a student — say what's actually broken instead. */}
          {!status.cloud && <div className="warn">{L("Les comptes ne sont pas encore activés sur ce serveur.", "Accounts aren't set up on this server yet.")}</div>}
          {mode === "forgot" && resetSent ? (
            <p className="settings-hint">{L("Si un compte existe avec cette adresse, un e-mail vient de partir avec un lien de réinitialisation.", "If an account exists with that address, an email with a reset link just went out.")}</p>
          ) : mode === "reset" && resetDone ? (
            <p className="settings-hint">{L("Mot de passe mis à jour — connexion en cours…", "Password updated — logging you in…")}</p>
          ) : (
            <>
              {mode !== "reset" && (
                <label className="field"><span>{L("Email", "Email")}</span>
                  <input className="addinput" type="email" autoComplete="email" placeholder={L("toi@email.com", "you@email.com")} value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
                </label>
              )}
              {mode !== "forgot" && (
                <label className="field"><span>{mode === "reset" ? L("Nouveau mot de passe", "New password") : L("Mot de passe", "Password")}</span>
                  <input className="addinput" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} placeholder={L("8 caractères minimum", "At least 8 characters")} value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void submit(); }} autoFocus={mode === "reset"} />
                </label>
              )}
              {/* RGPD Art.8: under-15s need a parent to set the account up (see Privacy Policy) — a required,
                  recorded checkbox instead of the previous text-only claim with no actual signal captured. */}
              {mode === "signup" && (
                <>
                  <label className="field-check">
                    <input type="checkbox" checked={isChildAccount} onChange={(e) => setIsChildAccount(e.target.checked)} />
                    <span>{L("C'est un compte pour un enfant (moins de 15 ans)", "This is a child account (under 15)")}</span>
                  </label>
                  {isChildAccount && (
                    <>
                      <label className="field"><span>{L("Année de naissance", "Birth year")}</span>
                        <input className="addinput" type="number" placeholder="2010" value={birthYear} onChange={(e) => setBirthYear(e.target.value)} />
                      </label>
                      <label className="field-check">
                        <input type="checkbox" checked={parentalConsent} onChange={(e) => setParentalConsent(e.target.checked)} />
                        <span>{L("En tant que parent, je consens à la création de ce compte.", "As a parent, I consent to this account creation.")}</span>
                      </label>
                    </>
                  )}
                  {!isChildAccount && (
                    <label className="field-check">
                      <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                      <span>{L("J'ai 15 ans ou plus, ou un parent a créé ce compte pour moi.", "I'm 15 or older, or a parent set this account up for me.")}</span>
                    </label>
                  )}
                </>
              )}
              {err && <div className="autherr">{err}</div>}
              <button className="btn primary big" disabled={busy || (mode === "forgot" ? !email.trim() : mode === "reset" ? !pw : !email.trim() || !pw || (mode === "signup" && !consent))} onClick={() => void submit()}>
                {busy ? "…" : mode === "signup" ? L("Créer le compte", "Create account") : mode === "forgot" ? L("Envoyer le lien", "Send link") : mode === "reset" ? L("Changer le mot de passe", "Change password") : L("Se connecter", "Log in")}
              </button>
            </>
          )}
          {mode === "login" && (
            <button className="btn ghost" onClick={() => { setMode("forgot"); setErr(""); setResetSent(false); }}>{L("Mot de passe oublié ?", "Forgot password?")}</button>
          )}
          {(mode === "login" || mode === "signup") && (
            <button className="btn ghost" onClick={() => { setMode((m) => (m === "signup" ? "login" : "signup")); setErr(""); }}>
              {mode === "signup" ? L("Déjà un compte ? Se connecter", "Have an account? Log in") : L("Nouveau ici ? Créer un compte", "New here? Create an account")}
            </button>
          )}
          {mode === "forgot" && (
            <button className="btn ghost" onClick={() => { setMode("login"); setErr(""); setResetSent(false); }}>{L("← Retour à la connexion", "← Back to login")}</button>
          )}
          <a className="login-back" href="/">{L("← Retour à l'accueil", "← Back to home")}</a>
          {/* target="_blank" deliberately — these would otherwise fall through this file's own SPA router
              (usePathRoute's click handler) which swaps the ENTIRE route to /terms or /privacy, unmounting
              this form and losing every typed field (email/password/consent/child-account fields) with no
              way back except restarting from scratch. Opening in a new tab keeps the signup form alive in
              THIS tab while the policy opens in its own — reported live as a signup-abandonment risk. */}
          <div className="login-legal">{L("En continuant, tu acceptes nos ", "By continuing you agree to our ")}<a href="/terms" target="_blank" rel="noopener">{L("conditions", "Terms")}</a> {L("et notre", "&")} <a href="/privacy" target="_blank" rel="noopener">{L("politique de confidentialité", "Privacy Policy")}</a>.</div>
          <div className="login-copyright">© 2026 Otto</div>
        </div>
      </main>
    </div>
  );
}
