


/** Marketing landing (signed out, route /). Plain white canvas, sharp positioning — one screen per
 *  idea, nothing decorative. Deliberately text-only: no product mock, no demo window. */
// Exported (not just used internally) so scripts/prerender-landing.tsx can render it in isolation at build
// time — the only piece of this whole SPA that gets static HTML pre-baked into dist/index.html, since it's
// the only screen a logged-out visitor or a non-JS crawler/link-unfurler ever needs to see real content
// for. See that script's own comment for why this is a build-time static render, not per-request SSR.
export function Landing({ lang, onLangChange }: { lang: "fr" | "en"; onLangChange: (v: "fr" | "en") => void }) {
  const en = lang === "en";
  const L = (fr: string, e: string) => (en ? e : fr);
  return (
    <div className="landing landing-min">
      <header className="landing-min-nav">
        <span className="landing-min-brand">otto</span>
        <nav>
          <a href="/research">{L("Approche", "Approach")}</a>
          <button type="button" onClick={() => onLangChange(en ? "fr" : "en")} aria-label={en ? "Switch language" : "Changer de langue"}>{en ? "FR" : "EN"}</button>
          <a href="/login">{L("Se connecter", "Log in")}</a>
        </nav>
      </header>
      <main className="landing-min-main">
        <h1>{L("Un partenaire de réflexion, pas une machine à réponses.", "A thinking partner, not an answer machine.")}</h1>
        <p>{L("Otto organise ta semaine, puis il t'oblige à faire le travail toi-même : il questionne ton raisonnement, repère tes failles et ne pense jamais à ta place. Fait pour les élèves qui veulent être affûtés, pas juste en avance sur leurs devoirs.", "Otto runs your school week, then makes you do the thinking: it questions your reasoning, finds the gaps in it, and never thinks for you. Built for students who want to be sharp, not just finished.")}</p>
        <p><a className="landing-min-cta" href="/signup">{L("Commencer à réfléchir", "Start thinking")}</a></p>
      </main>
      <footer className="landing-min-foot">
        <a href="/privacy">{L("Confidentialité", "Privacy")}</a>
        <a href="/terms">{L("Conditions", "Terms")}</a>
        <a href="/research">{L("Recherche", "Research")}</a>
      </footer>
    </div>
  );
}
