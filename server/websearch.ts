/**
 * Web search for task agents and study help — a real search API first, keyless scrapers as fallback.
 *
 * PRIMARY: Exa (https://exa.ai) — a proper search API built for AI agents, JSON in / JSON out, no
 * HTML scraping to break. Free tier (recurring monthly credits, no card) covers a few thousand
 * queries; set EXA_API_KEY to enable it. When the key is set, Exa is the only general-web provider
 * consulted — one fast, reliable, query-matched call instead of three fragile scraped ones.
 *
 * FALLBACK (no key, or Exa errored/empty): the old keyless stack — DuckDuckGo HTML, DuckDuckGo Lite,
 * DDG Instant Answer and Wikipedia, all regex-scraped/loose-match and genuinely fragile. DDG's HTML
 * endpoint now serves an anti-bot 202 challenge page that parses to ZERO results with no error thrown
 * (202 counts as ok), which is exactly how searches silently came back empty. The scrapers are kept
 * so search still works with zero config, but the real API is what makes it reliable.
 *
 * Wikipedia stays a FALL-BACK provider, not an equal peer: its `srsearch` is a loose keyword match
 * that happily returns a tangentially-related article (an unrelated person/place/topic that merely
 * shares a word with the query) — see wikipediaSearch's own relevance filter below.
 */
export type SearchResult = { title: string; url: string; snippet: string };
export interface SearchOpts {
  /** Restrict results to these hosts (e.g. ["ibdocuments.com"]). Passed to the API providers natively, and as
   *  site: terms + a post-filter for the keyless ones — a stray off-domain hit never gets through. */
  domains?: string[];
}

const hostOfUrl = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } };
const inDomains = (u: string, domains: string[]) => { const h = hostOfUrl(u); return !!h && domains.some((d) => h === d || h.endsWith(`.${d}`)); };

// Same question twice within minutes (a retry, two tool rounds, a daily deck + a chat) must not pay for two
// searches. Bounded; failures/empties are NOT cached so a transient outage heals on the next call.
const SEARCH_CACHE_TTL_MS = 10 * 60_000;
const searchCache = new Map<string, { at: number; value: SearchResult[] }>();
const inflight = new Map<string, Promise<SearchResult[]>>();

export async function webSearch(query: string, opts: SearchOpts = {}): Promise<SearchResult[]> {
  const q = query.trim();
  if (!q) return [];
  const domains = (opts.domains || []).map((d) => d.toLowerCase().replace(/^www\./, "")).filter(Boolean);
  const key = `${domains.join(",")}|${q.toLowerCase()}`;
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < SEARCH_CACHE_TTL_MS) return hit.value;
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = searchUncached(q, domains).then((value) => {
    if (value.length) {
      searchCache.set(key, { at: Date.now(), value });
      while (searchCache.size > 300) { const oldest = searchCache.keys().next().value; if (oldest === undefined) break; searchCache.delete(oldest); }
    }
    return value;
  }).finally(() => { inflight.delete(key); });
  inflight.set(key, p);
  return p;
}

/** Order results so on-domain and first-party hits lead, then drop exact-duplicate pages. */
export function rankResults(results: SearchResult[], domains: string[]): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const r of results) {
    if (!r?.url || !r.title) continue;
    if (domains.length && !inDomains(r.url, domains)) continue;
    const norm = r.url.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/[#?].*$/, "").replace(/\/$/, "");
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(r);
  }
  return out;
}

async function searchUncached(q: string, domains: string[]): Promise<SearchResult[]> {
  // Primary API providers, in order: Exa → Tavily → Brave. Each is optional (key-gated); the first that returns
  // anything wins, and an error or empty answer simply falls through to the next, then to the keyless stack.
  const providers: [string, string | undefined, (q: string, key: string, domains: string[]) => Promise<SearchResult[]>][] = [
    ["exa", process.env.EXA_API_KEY, exaSearch],
    ["tavily", process.env.TAVILY_API_KEY, tavilySearch],
    ["brave", process.env.BRAVE_API_KEY, braveSearch],
  ];
  const exaKey = (process.env.EXA_API_KEY || "").trim();
  for (const [name, rawKey, fn] of providers) {
    const key = (rawKey || "").trim();
    if (!key) continue;
    try {
      const res = rankResults(await fn(q, key, domains), domains);
      if (res.length) return res.slice(0, 10);
    } catch (err) {
      console.warn(`${new Date().toISOString()} [websearch] ${name} search failed (${err instanceof Error ? err.message : err}) — trying the next provider`);
    }
  }
  // Keyless stack: domain restriction goes in the query text (site:) and is re-checked on the way out.
  const siteTerms = domains.length ? ` (${domains.map((d) => `site:${d}`).join(" OR ")})` : "";
  const query = q + siteTerms;
  const [generalSettled, wikiSettled] = await Promise.allSettled([
    Promise.allSettled([duckDuckGoHtml(query), duckDuckGoLite(query), duckDuckGoInstant(query)]),
    domains.length ? Promise.resolve([] as SearchResult[]) : wikipediaSearch(q),
  ]);

  const combined: { title: string; url: string; snippet: string }[] = [];
  const seenUrls = new Set<string>();
  const add = (item: { title: string; url: string; snippet: string }) => {
    if (!item.url || !item.title) return;
    const normUrl = item.url.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "");
    if (seenUrls.has(normUrl)) return;
    seenUrls.add(normUrl);
    combined.push(item);
  };

  if (generalSettled.status === "fulfilled") {
    for (const res of generalSettled.value) if (res.status === "fulfilled") for (const item of res.value) add(item);
  }
  // Fill in with Wikipedia only up to a small cap, and only when the general web didn't already fill
  // the list — a genuinely thin result set (an obscure fact, a niche how-to) is exactly when an
  // encyclopedia entry is worth having; a query that already got 6+ real hits doesn't need it too.
  if (wikiSettled.status === "fulfilled" && combined.length < 6) {
    for (const item of wikiSettled.value.slice(0, 2)) add(item);
  }

  // Never let a total miss be silent again — the empty-202-challenge-page bug produced exactly this
  // with zero logs. When there's no Exa key, the warning doubles as the pointer to the fix.
  if (!combined.length) {
    console.warn(
      `${new Date().toISOString()} [websearch] all providers returned 0 results for "${q.slice(0, 100)}"` +
        (exaKey ? "" : " — set EXA_API_KEY for a real search API (DDG scraping is frequently bot-blocked)")
    );
  }

  return rankResults(combined, domains).slice(0, 10);
}

// ── Provider 0: Exa search API (primary; requires EXA_API_KEY) ──────────────
// Request shape per Exa's canonical guidance: query + type "auto" + bare highlights — nothing else.
// numResults defaults to 10 (exactly what we want); bare highlights:true auto-selects excerpt length;
// don't stack text/summary or set category/domain filters — this is a general web-search tool.
async function exaSearch(query: string, key: string, domains: string[] = []): Promise<{ title: string; url: string; snippet: string }[]> {
  const res = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: { "x-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({
      query,
      type: "auto",
      ...(domains.length ? { includeDomains: domains } : {}),
      contents: { highlights: true },
    }),
    signal: AbortSignal.timeout(9000),
  });
  if (!res.ok) throw new Error(`exa ${res.status}`);
  const json = await res.json() as any;
  return (Array.isArray(json?.results) ? json.results : [])
    .filter((r: unknown) => r && typeof r === "object")
    .map((r: any) => ({
      title: String(r.title || ""),
      url: String(r.url || ""),
      snippet: (Array.isArray(r.highlights) && r.highlights.length ? r.highlights.join(" … ") : String(r.text || ""))
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 300),
    }))
    .filter((x: { title: string; url: string }) => x.title && x.url);
}


// ── Provider 0b: Tavily (TAVILY_API_KEY) ───────────────────────────────────
async function tavilySearch(query: string, key: string, domains: string[] = []): Promise<SearchResult[]> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, max_results: 8, search_depth: "basic", ...(domains.length ? { include_domains: domains } : {}) }),
    signal: AbortSignal.timeout(9000),
  });
  if (!res.ok) throw new Error(`tavily ${res.status}`);
  const json = await res.json() as any;
  return (Array.isArray(json?.results) ? json.results : []).map((r: any) => ({ title: String(r?.title || ""), url: String(r?.url || ""), snippet: String(r?.content || "").replace(/\s+/g, " ").trim().slice(0, 300) }));
}

// ── Provider 0c: Brave Search API (BRAVE_API_KEY) ──────────────────────────
async function braveSearch(query: string, key: string, domains: string[] = []): Promise<SearchResult[]> {
  const q = domains.length ? `${query} (${domains.map((d) => `site:${d}`).join(" OR ")})` : query;
  const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=10`, {
    headers: { "x-subscription-token": key, accept: "application/json" },
    signal: AbortSignal.timeout(9000),
  });
  if (!res.ok) throw new Error(`brave ${res.status}`);
  const json = await res.json() as any;
  return (Array.isArray(json?.web?.results) ? json.web.results : []).map((r: any) => ({ title: stripTags(String(r?.title || "")), url: String(r?.url || ""), snippet: stripTags(String(r?.description || "")).slice(0, 300) }));
}

/** Read one web page as plain text (for a result the snippet can't answer from). SSRF-checked, no redirects to
 *  unchecked hosts, size/time capped; "" for anything unreadable. */
export async function readPage(url: string, maxChars = 6000): Promise<string> {
  try {
    const { assertSafeExternalUrl } = await import("./pronote.ts");
    await assertSafeExternalUrl(url);
    const r = await fetch(url, { signal: AbortSignal.timeout(6000), redirect: "error", headers: { "user-agent": "Mozilla/5.0 (compatible; OttoStudyBot/1.0)" } });
    const ct = r.headers.get("content-type") || "";
    if (!r.ok || !/text\/html|text\/plain/i.test(ct)) return "";
    const html = (await r.text()).slice(0, 1_500_000);
    const text = html
      .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>|<nav[\s\S]*?<\/nav>|<footer[\s\S]*?<\/footer>/gi, " ")
      .replace(/<\/(p|div|li|tr|h[1-6]|br)>/gi, "\n");
    return stripTags(text.replace(/<\/?[^>]+>/g, (m) => (/^<\/(p|div|li|tr|h[1-6])/i.test(m) ? "\n" : " "))).slice(0, maxChars);
  } catch { return ""; }
}

// ── Provider 1: DuckDuckGo HTML ─────────────────────────────────────────────
async function duckDuckGoHtml(query: string): Promise<{ title: string; url: string; snippet: string }[]> {
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" },
    signal: AbortSignal.timeout(7000),
  });
  if (!res.ok) throw new Error(`ddg html ${res.status}`);
  const html = await res.text();
  const out: { title: string; url: string; snippet: string }[] = [];
  const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snipRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = snipRe.exec(html))) snippets.push(stripTags(m[1]));
  let i = 0;
  while ((m = linkRe.exec(html)) && out.length < 8) {
    const url = decodeDdgUrl(m[1]);
    const title = stripTags(m[2]);
    if (url && title) { out.push({ title, url, snippet: snippets[i] || "" }); i++; }
  }
  return out;
}

// ── Provider 2: DuckDuckGo Lite ─────────────────────────────────────────────
async function duckDuckGoLite(query: string): Promise<{ title: string; url: string; snippet: string }[]> {
  const res = await fetch(`https://lite.duckduckgo.com/lite/`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    },
    body: `q=${encodeURIComponent(query)}`,
    signal: AbortSignal.timeout(7000),
  });
  if (!res.ok) throw new Error(`ddg lite ${res.status}`);
  const html = await res.text();
  const out: { title: string; url: string; snippet: string }[] = [];
  const rowRe = /<a[^>]*class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/g;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(html)) && out.length < 8) {
    const url = decodeDdgUrl(m[1]);
    const title = stripTags(m[2]);
    const snippet = stripTags(m[3]);
    if (url && title) out.push({ title, url, snippet });
  }
  return out;
}

// ── Provider 3: Wikipedia REST API ──────────────────────────────────────────
async function wikipediaSearch(query: string): Promise<{ title: string; url: string; snippet: string }[]> {
  const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&origin=*`;
  const res = await fetch(url, {
    headers: { "user-agent": "OttoStudentAssistant/1.0 (https://otto-app.dev; support@otto-app.dev)" },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`wiki ${res.status}`);
  const json = await res.json() as any;
  const items = json?.query?.search || [];
  // Wikipedia's own `srsearch` is a loose keyword match, not a relevance-ranked query match — it will
  // happily return a real article that just happens to share ONE word with the query and is otherwise
  // unrelated (the actual "sometimes it doesn't make sense" complaint: a search for a task topic
  // surfacing an unrelated person/place/event page). Require the title itself to share a real word
  // (4+ letters, so short connectors like "the"/"for" don't count) with the query — this is the same
  // signal that already gates task links elsewhere (see dropForeignEntityLinks), applied at the source.
  const queryWords = new Set(query.toLowerCase().match(/[a-zà-ÿ]{4,}/gi)?.map((w) => w.toLowerCase()) || []);
  const titleMatchesQuery = (title: string) => {
    if (!queryWords.size) return true; // too short a query to judge — don't over-filter
    const titleWords = title.toLowerCase().match(/[a-zà-ÿ]{4,}/gi) || [];
    return titleWords.some((w) => queryWords.has(w));
  };
  return items
    .map((item: any) => ({
      title: String(item.title || ""),
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(item.title || "").replace(/ /g, "_"))}`,
      snippet: stripTags(String(item.snippet || "")),
    }))
    .filter((x: any) => x.title && x.snippet && titleMatchesQuery(x.title))
    .slice(0, 4);
}

// ── Provider 4: DuckDuckGo Instant Answer API ──────────────────────────────
async function duckDuckGoInstant(query: string): Promise<{ title: string; url: string; snippet: string }[]> {
  const res = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`ddg instant ${res.status}`);
  const data = await res.json() as any;
  const out: { title: string; url: string; snippet: string }[] = [];
  if (data?.AbstractText && data?.AbstractURL) {
    out.push({
      title: String(data.Heading || data.AbstractSource || query),
      url: String(data.AbstractURL),
      snippet: String(data.AbstractText),
    });
  }
  for (const topic of (data?.RelatedTopics || [])) {
    if (topic?.Text && topic?.FirstURL && out.length < 5) {
      out.push({
        title: String(topic.Text).slice(0, 60),
        url: String(topic.FirstURL),
        snippet: String(topic.Text),
      });
    }
  }
  return out;
}

// ── Helpers ─────────────────────────────────────────────────────────────────
const stripTags = (s: string) => s
  .replace(/<[^>]+>/g, "")
  .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
  .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
  .replace(/\s+/g, " ").trim();

function decodeDdgUrl(href: string): string {
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (m) { try { return decodeURIComponent(m[1]); } catch { /* fall through */ } }
  return href.startsWith("//") ? "https:" + href : href;
}
