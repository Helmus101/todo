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
import { POSTS, postPath } from "../shared/blog.ts";
import { BlogIndexPage, BlogPostPage } from "../client/pages/Blog.tsx";
import { mkdirSync } from "node:fs";

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

// ── Blog: an index page and one static page per post, each with Article structured data ──
mkdirSync(resolve(__dirname, "../dist/blog"), { recursive: true });
const withJsonLd = (page: string, data: object) => page.replace("</head>", `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>\n  </head>`);
{
  const meta = PAGE_META.blog;
  const inner = renderToStaticMarkup(<LangContext.Provider value="en"><BlogIndexPage /></LangContext.Provider>);
  const page = withJsonLd(headFor(html, meta).replace('<div id="root"></div>', `<div id="root">${inner}</div>`), {
    "@context": "https://schema.org", "@type": "Blog", name: "Otto blog", url: ORIGIN + "/blog", description: meta.description, inLanguage: "en",
    blogPost: POSTS.map((p) => ({ "@type": "BlogPosting", headline: p.title, url: ORIGIN + postPath(p), datePublished: p.date })),
  });
  writeFileSync(resolve(__dirname, "../dist/blog.html"), page, "utf-8");
  console.log(`[prerender] blog.html — ${POSTS.length} posts`);
}
for (const post of POSTS) {
  const meta = PAGE_META[`blog/${post.slug}`];
  const inner = renderToStaticMarkup(<LangContext.Provider value="en"><BlogPostPage slug={post.slug} /></LangContext.Provider>);
  const page = withJsonLd(headFor(html, meta).replace('<div id="root"></div>', `<div id="root">${inner}</div>`), {
    "@context": "https://schema.org", "@type": "BlogPosting", headline: post.title, description: post.description,
    datePublished: post.date, dateModified: post.date, inLanguage: "en", mainEntityOfPage: ORIGIN + postPath(post),
    author: { "@type": "Organization", name: "Otto", url: ORIGIN }, publisher: { "@type": "Organization", name: "Otto", url: ORIGIN },
    image: ORIGIN + "/og-image.png",
  });
  writeFileSync(resolve(__dirname, `../dist/blog/${post.slug}.html`), page, "utf-8");
}
console.log(`[prerender] blog/*.html — ${POSTS.length} posts`);

// ── Sitemap: every public page, with the build date (replaces a hand-edited file that went stale) ──
{
  const today = new Date().toISOString().slice(0, 10);
  const urls: [string, string, string][] = [
    ["/", "weekly", "1.0"], ["/research", "monthly", "0.6"], ["/blog", "weekly", "0.8"],
    ...POSTS.map((p) => [postPath(p), "monthly", "0.7"] as [string, string, string]),
    ["/privacy", "monthly", "0.3"], ["/terms", "monthly", "0.3"],
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(([path, freq, prio]) => `  <url>\n    <loc>${ORIGIN}${path === "/" ? "/" : path}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>${freq}</changefreq>\n    <priority>${prio}</priority>\n  </url>`).join("\n")}\n</urlset>\n`;
  writeFileSync(resolve(__dirname, "../dist/sitemap.xml"), xml, "utf-8");
  console.log(`[prerender] sitemap.xml — ${urls.length} urls`);
}
void ORIGIN;
