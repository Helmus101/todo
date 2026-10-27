import { LanguagePicker } from "../LanguagePicker.tsx";
import { Testimonials } from "./Testimonials.tsx";
import { AiLogo } from "./AiLogos.tsx";
import { LandingDetails } from "./LandingDetails.tsx";



/** Marketing landing (signed out, route /). Plain white canvas, sharp positioning — one screen per
 *  idea, nothing decorative. Deliberately text-only: no product mock, no demo window. */
// Exported (not just used internally) so scripts/prerender-landing.tsx can render it in isolation at build
// time — the only piece of this whole SPA that gets static HTML pre-baked into dist/index.html, since it's
// the only screen a logged-out visitor or a non-JS crawler/link-unfurler ever needs to see real content
// for. See that script's own comment for why this is a build-time static render, not per-request SSR.
const ASK_PROMPT = (site: string) => `I want to see if I should use Otto${site ? ` (${site})` : ""}, which is a voice-first AI tutor with a shared whiteboard, built for the IB Diploma first (every subject group: Maths AA and AI, the sciences, Economics, History, languages, the arts, plus TOK, the Extended Essay and CAS, taught to your papers, command terms and mark schemes at your level, HL or SL) and it also works for other curricula, with the same method but without the IB depth. How it works: it asks guiding questions before explaining, but if you already know something it moves on, and if you're stuck after two tries it explains plainly and checks with a fresh example; you talk out loud (typing works too) and it writes the working on a board with typeset maths, graphs and multiple choice, with the board's arithmetic checked by code; it can connect to Pronote if your school uses it, to read homework, tests and grades (read-only, nothing is sent for you); it keeps evidence of whether you solved something alone, after a hint or only after an explanation, plus repeat mistakes, and only calls a topic mastered after you pass it unaided on a fresh problem; and before closing a topic it gives you a fresh problem with no help. It works in 10 languages. Its practice questions are exam-style, not official past-paper questions, and its subject knowledge can be wrong or out of date, so check it against your subject guide. It is not an official IB product. Your sessions are saved to your account, audio and text are processed by AI providers, and you can export or delete your account. Note it is NOT HeyOtto (heyotto.app), a different product. Please tell me honestly: (1) what a good AI tutor should do and how Otto compares, and why each feature helps me learn; (2) why Otto could be a good fit for me; (3) why it might not be, and who should use something else instead; (4) what to watch out for with any AI tutor (accuracy, relying on it too much, privacy). If you can't verify something about Otto, say so instead of guessing. Keep it short and specific, no hype.`;
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
        <p>{"Otto is the voice tutor built for the IB Diploma, and it works for any other course too. It never hands you the answer. It asks. You work it out, on a shared whiteboard, out loud, to the standard of your papers and mark schemes. A topic only counts as learned once you can do it alone."}</p>
        <p><a className="landing-min-cta" href="/signup">{"Start talking"}</a></p>
        <section className="landing-ask" aria-label="Ask an AI about Otto">
          <h2>{"Should you use Otto? Ask an AI."}</h2>
          <p>{"One click opens your favourite assistant with a ready-made question: should you use Otto? It lists what Otto does, why that helps you learn, and who it isn't for."}</p>
          <div className="landing-ask-row">
            {ASK_TARGETS.map((t) => (
              <a key={t.name} className="landing-ask-btn" target="_blank" rel="noopener noreferrer" translate="no"
                href={t.url(encodeURIComponent(ASK_PROMPT(typeof window !== "undefined" ? window.location.origin : "")))}
                onClick={(e) => { e.currentTarget.href = t.url(encodeURIComponent(ASK_PROMPT(window.location.origin))); }}><AiLogo name={t.name} />{t.name}</a>
            ))}
          </div>
        </section>
        <LandingDetails />
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
