/** Per-page head metadata for the public pages (title, description, canonical, social tags). Used at build time by
 *  scripts/prerender-landing.tsx to write dist/<page>.html, and at runtime by the client to keep the tab title and
 *  canonical right when someone navigates between pages without a reload. */
import { POSTS, postPath } from "./blog.ts";

export const ORIGIN = "https://hiotto.vercel.app";

export interface PageMeta { path: string; title: string; description: string }

export const PAGE_META: Record<string, PageMeta> = {
  research: {
    path: "/research",
    title: "How Otto teaches — the research behind a Socratic voice tutor",
    description: "Why saying it out loud helps you learn, and how Otto is built for the IB: questions before answers, retrieval practice, mastery shown by unaided work, and honest limits.",
  },
  privacy: {
    path: "/privacy",
    title: "Privacy Policy — what Otto stores and where | Otto",
    description: "What happens to your voice, transcripts and drawings, what stays in your browser, what we store on our servers, and how to export or delete your data.",
  },
  terms: {
    path: "/terms",
    title: "Terms of Service | Otto",
    description: "The terms for using Otto, the voice tutor with a shared whiteboard: who can use it, acceptable use, AI limitations and your rights.",
  },
};

PAGE_META.blog = {
  path: "/blog",
  title: "Otto blog: study methods that work, with the research behind them",
  description: "Short guides to active recall, spaced repetition, worked examples, interleaving and essay arguments, each based on published studies.",
};
for (const p of POSTS) PAGE_META[`blog/${p.slug}`] = { path: postPath(p), title: `${p.title} | Otto`, description: p.description };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** Rewrite the home page's <head> for another page: title, description, canonical, Open Graph and Twitter tags. */
export function headFor(indexHtml: string, m: PageMeta): string {
  const url = ORIGIN + m.path;
  return indexHtml
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(m.title)}</title>`)
    .replace(/(<meta name="description" content=")[^"]*(")/, `$1${esc(m.description)}$2`)
    .replace(/(<link rel="canonical" href=")[^"]*(")/, `$1${url}$2`)
    .replace(/(<meta property="og:url" content=")[^"]*(")/, `$1${url}$2`)
    .replace(/(<meta property="og:title" content=")[^"]*(")/, `$1${esc(m.title)}$2`)
    .replace(/(<meta property="og:description" content=")[^"]*(")/, `$1${esc(m.description)}$2`)
    .replace(/(<meta name="twitter:title" content=")[^"]*(")/, `$1${esc(m.title)}$2`)
    .replace(/(<meta name="twitter:description" content=")[^"]*(")/, `$1${esc(m.description)}$2`);
}
