// Build-time static prerender for the logged-out landing page ONLY — not full SSR of the app. Otto is a
// client-side SPA behind login, heavy on browser-only APIs (webcam/MediaPipe, Web Speech, IndexedDB) that
// simply can't run server-side, and per-request SSR of an authenticated productivity app buys nothing a
// visitor can't already get from a fast client render. The one real gap: dist/index.html's <body> was an
// empty <div id="root"></div> until React hydrates, so a crawler or link-unfurler that doesn't execute JS
// (or that renders before the async /api/status round-trip resolves) saw no landing content at all — even
// though the <head>'s OG/meta tags were already static and fine. This script closes exactly that gap: it
// renders the Landing component to static HTML once, at build time, and bakes it into dist/index.html's
// #root. The client still boots normally afterward (see main.tsx) and replaces this markup with a live,
// interactive render — the prerendered HTML is a first-paint/crawler fallback, not a hydration target, so
// there's no hydration-mismatch risk to manage here.
import React from "react"; // tsx's standalone JSX transform for this entry doesn't pick up tsconfig's automatic runtime — keep this explicit so `<Landing .../>` below doesn't throw "React is not defined".
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { Landing } from "../client/pages/Landing.tsx";
import { PrivacyBody, TermsBody, ResearchPageBody } from "../client/pages/Legal.tsx";
import { LangContext } from "../client/ui.tsx";
import { PAGE_META, ORIGIN, headFor } from "../shared/seo.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distIndexPath = resolve(__dirname, "../dist/index.html");

const html = readFileSync(distIndexPath, "utf-8");
if (!html.includes('<div id="root"></div>')) {
  console.warn("[prerender-landing] dist/index.html's #root wasn't the expected empty shell — skipping (build markup may have changed).");
  process.exit(0);
}

// site lang is "fr" (index.html's <html lang="fr">) — prerender in the matching language so the static
// fallback isn't visibly mismatched from the page's own declared language.
const markup = renderToStaticMarkup(<Landing lang="fr" onLangChange={() => {}} />);
const out = html.replace('<div id="root"></div>', `<div id="root">${markup}</div>`);
writeFileSync(distIndexPath, out, "utf-8");
console.log(`[prerender-landing] baked ${(markup.length / 1024).toFixed(1)}kb of static landing markup into dist/index.html`);

// ── The other public pages get their OWN static HTML (title, description, canonical, social tags, real content) ──
// Before this, /research, /privacy and /terms all served the home page's index.html: identical title and a canonical
// pointing at "/", so search engines treated them as duplicates of the home page. Each is written to dist/<name>.html
// and served at /<name> (vercel.json rewrite; server/index.ts for self-hosting).
const bodies: Record<string, React.ReactElement> = {
  research: <ResearchPageBody />,
  privacy: <PrivacyBody />,
  terms: <TermsBody />,
};
for (const [route, node] of Object.entries(bodies)) {
  const meta = PAGE_META[route];
  const inner = renderToStaticMarkup(
    <LangContext.Provider value="en">
      <div className="landing legal-page">
        <header className="landing-nav glass-nav"><a className="brand" href="/">Otto</a><nav className="landing-navlinks"><a className="btn ghost" href="/research">Approach</a><a className="btn ghost" href="/privacy">Privacy</a><a className="btn ghost" href="/terms">Terms</a></nav></header>
        <main className="legal">{node}<a className="legal-back" href="/">← Back to Otto</a></main>
      </div>
    </LangContext.Provider>,
  );
  const page = headFor(html, meta).replace('<div id="root"></div>', `<div id="root">${inner}</div>`);
  writeFileSync(resolve(__dirname, `../dist/${route}.html`), page, "utf-8");
  console.log(`[prerender] ${route}.html — ${(inner.length / 1024).toFixed(1)}kb, title "${meta.title}"`);
}

// Sitemap freshness: lastmod is the build date, not a hand-edited constant that goes stale.
try {
  const smPath = resolve(__dirname, "../dist/sitemap.xml");
  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(smPath, readFileSync(smPath, "utf-8").replace(/<lastmod>[^<]*<\/lastmod>/g, `<lastmod>${today}</lastmod>`), "utf-8");
} catch { /* the static copy in public/ stays as is */ }
void ORIGIN;
