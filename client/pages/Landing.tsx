import { POSTS, postPath } from "../../shared/blog.ts";
import { LanguagePicker } from "../LanguagePicker.tsx";



/** Marketing landing (signed out, route /). Plain white canvas, sharp positioning — one screen per
 *  idea, nothing decorative. Deliberately text-only: no product mock, no demo window. */
// Exported (not just used internally) so scripts/prerender-landing.tsx can render it in isolation at build
// time — the only piece of this whole SPA that gets static HTML pre-baked into dist/index.html, since it's
// the only screen a logged-out visitor or a non-JS crawler/link-unfurler ever needs to see real content
// for. See that script's own comment for why this is a build-time static render, not per-request SSR.
const ASK_PROMPT = (site: string) => `I'm deciding whether to try Otto${site ? ` (${site})` : ""}, a voice-first Socratic AI tutor with a shared whiteboard: it asks questions instead of handing over answers, talks out loud, writes the working on a board, and remembers past sessions. Look it up and be honest with me: (1) why Otto is good, (2) why it could be right for me, (3) why it might NOT be right for me, and who should use something else instead. Keep it short and specific, with no hype.`;
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
          <h2>{"Not sure? Ask an AI."}</h2>
          <p>{"One click opens your favourite assistant with an honest question: why Otto is good, why it's for you, and why it isn't."}</p>
          <div className="landing-ask-row">
            {ASK_TARGETS.map((t) => (
              <a key={t.name} className="landing-ask-btn" target="_blank" rel="noopener noreferrer" translate="no"
                href={t.url(encodeURIComponent(ASK_PROMPT(typeof window !== "undefined" ? window.location.origin : "")))}
                onClick={(e) => { e.currentTarget.href = t.url(encodeURIComponent(ASK_PROMPT(window.location.origin))); }}>{t.name}</a>
            ))}
          </div>
        </section>
        <section className="landing-blog" aria-label="From the blog">
          <h2>{"Study methods that work"}</h2>
          <ul>{POSTS.slice(0, 3).map((p) => <li key={p.slug}><a href={postPath(p)}>{p.title}</a></li>)}</ul>
          <p><a href="/blog">{"All guides"}</a></p>
        </section>
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
