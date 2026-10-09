/**
 * Registered question sources — practice questions for IB / AP students come from the places those students
 * actually practise on (IB Documents, Revision Village; College Board's AP Central) instead of being invented
 * from nothing. Every other program keeps the generated-question path unchanged.
 *
 * How it works: web search is restricted to the source's own domain, the top page is fetched (SSRF-checked,
 * no redirects, size/time capped) and a short excerpt around the topic is handed to the tutor as material to
 * ADAPT — never to paste wholesale — together with a link so the student can open the original. Nothing here
 * is guaranteed to return anything (some sources sit behind a login): an empty result simply means "generate
 * as usual", and the tutor is told so. A source's host is the ONLY thing a question may cite — a link on a
 * problem is validated against this registry, so the model can't attach an invented source.
 */
import { webSearch } from "./websearch.ts";
import { assertSafeExternalUrl } from "./pronote.ts";

export type QuestionTrack = "ib" | "ap";
export interface QuestionSource { name: string; host: string; tracks: QuestionTrack[] }
export interface SourceQuestion { sourceName: string; url: string; title: string; excerpt: string }

export const QUESTION_SOURCES: QuestionSource[] = [
  // IB — question banks, mark-scheme sites and teacher-run resource sites (IB's own past papers aren't public).
  { name: "IB Documents", host: "ibdocuments.com", tracks: ["ib"] },
  { name: "Revision Village", host: "revisionvillage.com", tracks: ["ib"] },
  { name: "Save My Exams", host: "savemyexams.com", tracks: ["ib"] },
  { name: "IB Maths Resources", host: "ibmathsresources.com", tracks: ["ib"] },
  { name: "ThinkIB", host: "thinkib.net", tracks: ["ib"] },
  { name: "IB Academy", host: "ib.academy", tracks: ["ib"] },
  { name: "Khan Academy", host: "khanacademy.org", tracks: ["ib", "ap"] },
  // AP — College Board's free-response archive and AP-specific practice sites.
  { name: "AP Central (College Board)", host: "apcentral.collegeboard.org", tracks: ["ap"] },
  { name: "College Board", host: "collegeboard.org", tracks: ["ap"] },
  { name: "Albert", host: "albert.io", tracks: ["ap"] },
  { name: "Fiveable", host: "fiveable.me", tracks: ["ap"] },
  { name: "CrackAP", host: "crackap.com", tracks: ["ap"] },
  { name: "Save My Exams (AP)", host: "savemyexams.com", tracks: ["ap"] },
];

const hostOf = (url: string): string => { try { return new URL(url).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } };

/** The registered source a URL belongs to (exact host or a subdomain of it), if any. */
export function sourceForUrl(url: string): QuestionSource | undefined {
  const h = hostOf(url);
  if (!h) return undefined;
  return QUESTION_SOURCES.find((s) => h === s.host || h.endsWith(`.${s.host}`));
}

/** Only IB and AP students get sourced questions; every other program (and "no program") generates. */
export function sourcesForTrack(track: string | undefined): QuestionSource[] {
  return track === "ib" || track === "ap" ? QUESTION_SOURCES.filter((s) => s.tracks.includes(track)) : [];
}

/** Validate a source a problem wants to cite: https, a registered host, and the registry's canonical name. */
export function cleanProblemSource(url: unknown): { name: string; url: string } | undefined {
  const u = String(url || "").trim();
  if (!/^https:\/\//i.test(u) || u.length > 500) return undefined;
  const src = sourceForUrl(u);
  return src ? { name: src.name, url: u } : undefined;
}

const clamp = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<\/(p|div|li|tr|h[1-6]|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}

/** The ~max chars of a page most relevant to the topic: a window around the densest cluster of topic words,
 *  preferring text that looks like a question. "" when the page never mentions the topic (a login wall, a
 *  menu page) — so irrelevant pages are dropped instead of being passed on as "material". */
export function excerptAround(text: string, topic: string, max = 1400): string {
  const words = [...new Set(topic.toLowerCase().split(/[^a-zà-ÿ0-9]+/).filter((w) => w.length > 2))];
  if (!words.length || !text) return "";
  const lower = text.toLowerCase();
  let best = -1, bestScore = 0;
  const step = 200;
  for (let i = 0; i < lower.length; i += step) {
    const win = lower.slice(i, i + max);
    let score = 0;
    for (const w of words) if (win.includes(w)) score++;
    if (/\?|\b(find|calculate|determine|show that|solve|evaluate|expand|differentiate|integrate|prove|state)\b/.test(win)) score += 0.5;
    if (score > bestScore) { bestScore = score; best = i; }
  }
  // Need at least half the topic words (or one of one/two) to count as on-topic.
  if (best < 0 || bestScore < Math.max(1, Math.ceil(words.length / 2))) return "";
  return clamp(text.slice(best, best + max).trim(), max);
}

export interface SourceDeps {
  search: (q: string, domains: string[]) => Promise<{ title: string; url: string; snippet: string }[]>;
  fetchPage: (url: string) => Promise<string>;
}

async function realFetchPage(url: string): Promise<string> {
  await assertSafeExternalUrl(url);
  const r = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: "error", headers: { "user-agent": "Mozilla/5.0 (compatible; OttoStudyBot/1.0)" } });
  const ct = r.headers.get("content-type") || "";
  if (!r.ok || !/text\/html|text\/plain/i.test(ct)) return "";
  return htmlToText((await r.text()).slice(0, 1_500_000));
}
export const realSourceDeps: SourceDeps = { search: (q, domains) => webSearch(q, { domains }), fetchPage: realFetchPage };

const cache = new Map<string, { at: number; value: SourceQuestion[] }>();
const CACHE_TTL_MS = 24 * 3600_000;
const CACHE_MAX = 200;

/** Find up to `limit` on-topic excerpts from the student's registered sources. Never throws; [] = generate. */
export async function findSourceQuestions(
  input: { track?: string; subject?: string; topic: string; limit?: number },
  deps: SourceDeps = realSourceDeps,
): Promise<SourceQuestion[]> {
  const sources = sourcesForTrack(input.track);
  const topic = String(input.topic || "").trim().slice(0, 120);
  if (!sources.length || !topic) return [];
  const limit = Math.max(1, Math.min(3, input.limit ?? 2));
  const key = `${input.track}|${(input.subject || "").toLowerCase()}|${topic.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value.slice(0, limit);
  const out: SourceQuestion[] = [];
  const seen = new Set<string>();
  const run = async () => {
    // ONE search restricted to every registered host for this track (native includeDomains where the provider
    // supports it), then walk the results in rank order — a source with nothing simply contributes nothing.
    const hosts = [...new Set(sources.map((x) => x.host))];
    let results: { title: string; url: string; snippet: string }[] = [];
    try { results = await deps.search(`${input.subject || ""} ${topic} practice questions exam`.replace(/\s+/g, " ").trim(), hosts); } catch { return; }
    for (const r of results.slice(0, 8)) {
      if (out.length >= limit) break;
      // The search is advisory — re-check the host ourselves so a stray result can never smuggle in a foreign page.
      const found = r?.url ? sourceForUrl(r.url) : undefined;
      if (!found || seen.has(r.url) || !sources.some((x) => x.host === found.host)) continue;
      seen.add(r.url);
      let page = "";
      try { page = await deps.fetchPage(r.url); } catch { /* unreachable or blocked — fall back to the snippet */ }
      // A page we can't read (login wall) still has a snippet from the search itself: use that if it's on-topic.
      const excerpt = excerptAround(page, topic) || excerptAround(`${r.title}. ${r.snippet || ""}`, topic, 600);
      if (!excerpt) continue;
      out.push({ sourceName: found.name, url: r.url, title: clamp(String(r.title || ""), 140), excerpt });
    }
  };
  // Hard overall bound: the tutor's whole turn has a latency budget, so a slow source is abandoned, not awaited.
  await Promise.race([run(), new Promise<void>((res) => setTimeout(res, 7000))]);
  cache.set(key, { at: Date.now(), value: out });
  while (cache.size > CACHE_MAX) { const oldest = cache.keys().next().value; if (oldest === undefined) break; cache.delete(oldest); }
  return out.slice(0, limit);
}
