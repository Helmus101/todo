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
import { Landing } from "../client/App.tsx";

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
