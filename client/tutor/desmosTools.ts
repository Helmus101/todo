// The Desmos tool family the Tutor Session offers — the tutor's one place for Desmos extensions the
// student can USE (reported: "make sure in the tutor you have a place for desmos extensions that user
// can use"). Pure data + URL contract, no React, so tests can pin it directly (same pattern as
// client/voice/echoGuard.ts and speechErrors.ts: a pure module beside the component that renders it).
//
// WHY IFRAMES, NOT THE DESMOS API: Study Mode already embeds Desmos this way
// (client/study/artifacts/DesmosArtifact.tsx) — the app's CSP (vercel.json) allows any https frame
// (`frame-src 'self' blob: https:`) but would NOT load Desmos's calculator.js from desmos.com
// (script-src is 'self' + cdn.jsdelivr.net only). The iframe keeps a single embedding contract across
// both surfaces and needs no CSP change.

// ONE calculator only (was four, tab-switched) — reported live: the Tutor's Desmos place should offer a
// single tool, not a picker. Graphing is the default kept: most versatile, and what "Desmos" means to most
// students by default (plot a function, find a root, read behavior) — covers far more of what actually
// comes up mid-lesson than the scientific/geometry/four-function variants did. Study Mode's own
// DesmosArtifact.tsx (client/study/artifacts/) is untouched — this only shrinks the TUTOR's own picker.
export const DESMOS_TOOLS = [
  {
    id: "graphing",
    path: "https://www.desmos.com/calculator",
    label: ["Graphique", "Graphing"],
    hint: [
      "Trace des fonctions, trouve les racines, regarde les variations.",
      "Plot functions, find roots, watch the behavior.",
    ],
  },
] as const;

export type DesmosToolId = (typeof DESMOS_TOOLS)[number]["id"];

/** The embed URL for a tool id — all call sites go through here so the URL contract has one home. */
export function desmosToolUrl(id: DesmosToolId): string {
  const tool = DESMOS_TOOLS.find((t) => t.id === id) || DESMOS_TOOLS[0];
  return tool.path;
}

// The iframe contract, as code: EXACTLY these four desmos.com calculator pages, https, no path suffix.
// Anything else (a lookalike domain, an arbitrary Desmos deep-link, plain http) is not an embed this
// app has agreed to open — mirrors how ToolsDrawer.tsx hard-codes the one class of external content
// (Google Docs) allowed to appear mid-session.
export function isDesmosEmbedUrl(url: string): boolean {
  return /^https:\/\/(www\.)?desmos\.com\/(calculator|scientific|geometry|fourfunction)\/?$/.test(url);
}
