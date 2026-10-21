import { LanguagePicker } from "../LanguagePicker.tsx";



/** Marketing landing (signed out, route /). Plain white canvas, sharp positioning — one screen per
 *  idea, nothing decorative. Deliberately text-only: no product mock, no demo window. */
// Exported (not just used internally) so scripts/prerender-landing.tsx can render it in isolation at build
// time — the only piece of this whole SPA that gets static HTML pre-baked into dist/index.html, since it's
// the only screen a logged-out visitor or a non-JS crawler/link-unfurler ever needs to see real content
// for. See that script's own comment for why this is a build-time static render, not per-request SSR.
export function Landing({ lang, onLangChange }: { lang: "fr" | "en"; onLangChange: (v: "fr" | "en") => void }) {
  const en = lang === "en";
  const L = (fr: string, e: string) => (e);
  return (
    <div className="landing landing-min">
      <header className="landing-min-nav">
        <span className="landing-min-brand">otto</span>
        <nav>
          <a href="/research">{"Approach"}</a>
          <a href="/login">{"Log in"}</a>
        </nav>
      </header>
      <main className="landing-min-main">
        <h1>{"Think out loud. Get it right."}</h1>
        <p>{"Otto never hands you the answer. He asks. You work it out, on a shared whiteboard, out loud. The mistakes you make once, you won't make twice."}</p>
        <p><a className="landing-min-cta" href="/signup">{"Start talking"}</a></p>
      </main>
      <footer className="landing-min-foot">
        <a href="/privacy">{"Privacy"}</a>
        <a href="/terms">{"Terms"}</a>
        <a href="/research">{"Research"}</a>
        <LanguagePicker compact />
      </footer>
    </div>
  );
}
