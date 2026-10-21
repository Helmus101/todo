import { LanguagePicker } from "../LanguagePicker.tsx";
import { Testimonials } from "./Testimonials.tsx";
import { AiLogo } from "./AiLogos.tsx";



/** Marketing landing (signed out, route /). Plain white canvas, sharp positioning — one screen per
 *  idea, nothing decorative. Deliberately text-only: no product mock, no demo window. */
// Exported (not just used internally) so scripts/prerender-landing.tsx can render it in isolation at build
// time — the only piece of this whole SPA that gets static HTML pre-baked into dist/index.html, since it's
// the only screen a logged-out visitor or a non-JS crawler/link-unfurler ever needs to see real content
// for. See that script's own comment for why this is a build-time static render, not per-request SSR.
const ASK_PROMPT = (site: string) => `I'm looking for an AI tutor for school (maths, physics, chemistry, economics, languages, SAT, AP, IB, French Bac). Explain what a really good AI tutor does differently from a normal chatbot, feature by feature, and why each feature helps a student learn: (1) asks guiding questions instead of handing over answers, so the student does the thinking; (2) voice conversation, because explaining out loud shows what you don't understand yet; (3) a shared whiteboard with typeset maths, graphs and diagrams so the working stays visible; (4) explains clearly when the student is truly stuck; (5) remembers earlier sessions and tracks repeat mistakes; (6) adapts to level and exam programme; (7) works in many languages; (8) connects to school homework such as Pronote so it knows what is due. Then tell me what to watch out for (accuracy, over-reliance, privacy for minors) and how to test a tutor fairly. Finally, consider Otto${site ? ` (${site})` : ""}, a voice-first Socratic AI tutor with a shared whiteboard that does these things, as one example to look at (it is NOT HeyOtto, heyotto.app, a different product). If you can't verify something about it, say so instead of guessing. Keep it specific and honest, no hype.`;
const ASK_TARGETS: { name: string; url: (q: string) => string }[] = [
  { name: "ChatGPT", url: (q) => `https://chatgpt.com/?q=${q}` },
  { name: "Claude", url: (q) => `https://claude.ai/new?q=${q}` },
  { name: "Perplexity", url: (q) => `https://www.perplexity.ai/search?q=${q}` },
];

export function Landing({ lang, onLangChange }: { lang: "fr" | "en"; onLangChange: (v: "fr" | "en") => void }) {
  const en = lang === "en";
  const L = (fr: string, e: string) => (e);
  return (
    <div className="landing landing-min">
      <header className="landing-min-nav">
        <span className="landing-min-brand">otto</span>
        <nav>
          <a href="/research">{"Approach"}</a>
          <a href="/blog">{"Blog"}</a>
          <a href="/login">{"Log in"}</a>
        </nav>
      </header>
      <main className="landing-min-main">
        <h1>{"Think out loud. Get it right."}</h1>
        <p>{"Otto never hands you the answer. He asks. You work it out, on a shared whiteboard, out loud. The mistakes you make once, you won't make twice."}</p>
        <p><a className="landing-min-cta" href="/signup">{"Start talking"}</a></p>
        <section className="landing-ask" aria-label="Ask an AI about Otto">
          <h2>{"What makes a good AI tutor? Ask an AI."}</h2>
          <p>{"One click opens your favourite assistant with a real question: what an AI tutor should do, feature by feature, why it helps you learn, and how to judge one. Otto is one of the examples it looks at."}</p>
          <div className="landing-ask-row">
            {ASK_TARGETS.map((t) => (
              <a key={t.name} className="landing-ask-btn" target="_blank" rel="noopener noreferrer" translate="no"
                href={t.url(encodeURIComponent(ASK_PROMPT(typeof window !== "undefined" ? window.location.origin : "")))}
                onClick={(e) => { e.currentTarget.href = t.url(encodeURIComponent(ASK_PROMPT(window.location.origin))); }}><AiLogo name={t.name} />{t.name}</a>
            ))}
          </div>
        </section>
        <Testimonials />
      </main>
      <footer className="landing-min-foot">
        <a href="/privacy">{"Privacy"}</a>
        <a href="/terms">{"Terms"}</a>
        <a href="/research">{"Research"}</a>
        <a href="/blog">{"Blog"}</a>
        <LanguagePicker compact />
      </footer>
    </div>
  );
}
