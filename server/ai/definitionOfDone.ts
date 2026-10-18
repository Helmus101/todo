// Is this a GOOD definition of done, and does the brief for a task actually deliver it? Pure checks (no model, no network) — the pipeline
// uses them to decide when ONE repair call is worth making, never to invent text. Works for English and French goals.

const words = (t: string): string[] => String(t || "").toLowerCase().match(/[a-zà-ÿ0-9]{4,}/g) || [];
const STOP = new Set(["that", "this", "with", "from", "have", "will", "your", "their", "them", "then", "than", "when", "what", "which", "into", "dans", "pour", "avec", "sont", "elle", "vous", "nous", "cette", "tout", "tous", "plus", "sans", "être", "avoir"]);
const content = (t: string): string[] => words(t).filter((w) => !STOP.has(w));

/** Verbs/states that name something you can SEE is finished. */
const RESULT = /\b(?:sent|submitted|handed in|booked|confirmed|paid|signed|uploaded|saved|completed|passed|scored|solved|written|drafted|delivered|registered|received|finished|listed|chosen|decided|filed|packed|bought|ordered|installed|downloaded|printed|scheduled|reserved|answered|replied|posted|published|reviewed and corrected|marked|checked off|tested|memori[sz]ed|can (?:explain|solve|recite|write|do|name|list)|able to|without (?:notes|help|looking)|envoy[ée]e?s?|rendu(?:e|s)?|remis(?:e|es)?|r[ée]serv[ée]e?s?|confirm[ée]e?s?|pay[ée]e?s?|sign[ée]e?s?|termin[ée]e?s?|r[ée]dig[ée]e?s?|r[ée]solu(?:e|s)?|valid[ée]e?s?|inscrit(?:e|s)?|re[çc]u(?:e|s)?|achet[ée]e?s?|command[ée]e?s?|install[ée]e?s?|imprim[ée]e?s?|planifi[ée]e?s?|r[ée]pondu|publi[ée]e?s?|sait|savoir|capable de|sans (?:notes|aide))\b/i;
const QUANT = /\d|\b(?:all|every|each|both|at least|no more than|under|within|before|by)\b|\b(?:tous|toutes|chaque|au moins|avant|d'ici)\b/i;
/** Goals that say nothing: the canned template, "be ready", "work on", "understand". */
const GENERIC = /^\s*(?:successfully\s+)?(?:complete|finish|do|handle|work on|look into|think about|deal with|take care of|terminer|finir|faire|g[ée]rer)\s+(?:the\s+|this\s+|le\s+|la\s+|les\s+|ce\s+|cette\s+)?(?:task|assignment|work|homework|exercise|devoir|t[âa]che|travail|\w+ for \w+)\b/i;
const VAGUE_START = /^\s*(?:understand|learn(?: about)?|be ready|get ready|be prepared|prepare|review|study|look at|know|comprendre|apprendre|[êe]tre pr[êe]t|pr[ée]parer|r[ée]viser|conna[îi]tre)\b/i;

export interface GoalAssessment { ok: boolean; problems: string[] }

/** What is wrong with this definition of done (empty problems = fine). */
export function assessGoal(goal: string | undefined, title = ""): GoalAssessment {
  const g = String(goal || "").trim();
  const problems: string[] = [];
  if (!g) return { ok: false, problems: ["missing"] };
  const n = g.split(/\s+/).length;
  if (n < 5) problems.push("too short to be measurable");
  if (n > 45) problems.push("too long — a definition of done is one or two sentences");
  if (GENERIC.test(g)) problems.push("generic — it would fit any task");
  const gw = new Set(content(g)), tw = content(title);
  if (tw.length >= 3 && gw.size && tw.filter((w) => gw.has(w)).length / tw.length >= 0.8 && [...gw].filter((w) => !tw.includes(w)).length <= 1) problems.push("just repeats the title");
  const observable = RESULT.test(g) || QUANT.test(g);
  if (!observable) problems.push("no observable end state (what will be true when it is finished?)");
  else if (VAGUE_START.test(g) && !QUANT.test(g) && !/\b(?:can|able to|sait|capable|without|sans)\b/i.test(g)) problems.push("starts from a vague verb with no measurable result");
  return { ok: problems.length === 0, problems };
}

/** The distinct things a definition of done asks for ("purpose, dates and travellers booked, and documents identified" = three). */
export function dodParts(dod: string): string[] {
  return String(dod || "").split(/;|,\s*(?:and|et)\s+|\s+(?:and|et)\s+|,\s+/i).map((p) => p.trim().replace(/^(?:and|et)\s+/i, "")).filter((p) => content(p).length >= 1 && p.length >= 4);
}

const DONE_SECTION = /(?:^|\n)\s*(?:#{1,4}\s*|\*\*\s*)?(?:done when|definition of done|you(?:'| a)re done when|finished when|termin[ée] quand|c'est fini quand|fini quand|crit[èe]res? de r[ée]ussite)\b/i;

export interface BriefGaps { missingSection: boolean; uncovered: string[] }

/** Does the brief end with a "Done when" check, and does its text mention every part of the definition of done? */
export function briefGaps(body: string, dod: string): BriefGaps {
  const text = String(body || "");
  const hay = new Set(words(text));
  const uncovered = dodParts(dod).filter((p) => {
    const cw = content(p);
    return cw.length > 0 && cw.filter((w) => hay.has(w) || [...hay].some((h) => h.length > 5 && w.length > 5 && h.slice(0, 5) === w.slice(0, 5))).length / cw.length < 0.5;
  });
  return { missingSection: !DONE_SECTION.test(text), uncovered };
}

/** One rewrite instruction covering whatever is missing — null when the brief is fine. */
export function briefFix(gaps: BriefGaps, dod: string, small: boolean): string | null {
  if (!gaps.missingSection && !gaps.uncovered.length) return null;
  const parts: string[] = [];
  if (gaps.missingSection) parts.push(`end with a short "Done when" checklist: ${small ? "1-3" : "2-5"} checkable lines (each starts with "- [ ]"), taken from the definition of done: "${dod}"`);
  if (gaps.uncovered.length) parts.push(`the brief never covers ${gaps.uncovered.map((p) => `"${p}"`).join(", ")} — add the real specifics for ${gaps.uncovered.length > 1 ? "those" : "that"} (only from what the brief and context already contain) so the definition of done can actually be met`);
  return parts.join("; and ");
}
