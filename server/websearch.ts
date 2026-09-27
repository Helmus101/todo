/**
 * Web search for task agents and study help — parallelized multi-provider search engine.
 * Queries DuckDuckGo HTML, DuckDuckGo Lite, Wikipedia REST API, and DDG Instant Answer concurrently
 * via Promise.allSettled. Fast, resilient, keyless, and deduplicated.
 *
 * Wikipedia is deliberately a FALL-BACK provider, not an equal peer: the general-web providers (DDG
 * HTML/Lite) are the real query-matched results — Wikipedia's own `srsearch` is a loose keyword match
 * that happily returns a tangentially-related article (an unrelated person/place/topic that merely
 * shares a word with the query). When DDG scraping is having a bad day (bot-blocked, layout drift —
 * both regex-scraped, so genuinely fragile), Wikipedia used to end up as MOST of the results by sheer
 * concurrency, which is why real usage skewed "it's always Wikipedia" even though this function never
 * hard-codes it as a source. Now: general-web results are always listed first, Wikipedia only fills in
 * the remaining slots (capped small), and only for hits that actually share real vocabulary with the
 * query — see wikipediaSearch's own relevance filter below.
 */

/** Is this a Wikipedia URL, regardless of WHICH provider surfaced it? DuckDuckGo (HTML, Lite, and its
 *  Instant Answer API — DDG documents Wikipedia as one of its own sources) can and does return
 *  wikipedia.org links as ordinary "general web" results. Classifying by SOURCE FUNCTION instead of by
 *  destination let those slip past both the 2-result cap and the relevance filter below, entirely
 *  undoing the point of treating Wikipedia as a capped fallback — this is the actual gate, applied
 *  uniformly to every provider's output. */
const isWikipediaUrl = (url: string): boolean => /^https?:\/\/[a-z]{2,3}\.wikipedia\.org\//i.test(url);

/** Wikipedia's own `srsearch` (and, by extension, any other provider's incidental Wikipedia hit) is a
 *  loose keyword match, not a relevance-ranked query match — it will happily surface a real article that
 *  just happens to share ONE word with the query and is otherwise unrelated (the actual "sometimes it
 *  doesn't make sense" complaint: a search for a task topic surfacing an unrelated person/place/event
 *  page). Require the title itself to share a real word (4+ letters, so short connectors like "the"/"for"
 *  don't count) with the query — the same signal that already gates task links elsewhere (see
 *  dropForeignEntityLinks in server/claude.ts), applied here at the source. */
function wikiTitleMatchesQuery(title: string, query: string): boolean {
  const queryWords = query.toLowerCase().match(/[a-zà-ÿ]{4,}/gi);
  if (!queryWords?.length) return true; // too short a query to judge — don't over-filter
  const queryWordSet = new Set(queryWords);
  const titleWords = title.toLowerCase().match(/[a-zà-ÿ]{4,}/gi) || [];
  return titleWords.some((w) => queryWordSet.has(w));
}

export async function webSearch(query: string): Promise<{ title: string; url: string; snippet: string }[]> {
  const q = query.trim();
  if (!q) return [];

  const [generalSettled, wikiSettled] = await Promise.allSettled([
    Promise.allSettled([duckDuckGoHtml(q), duckDuckGoLite(q), duckDuckGoInstant(q)]),
    wikipediaSearch(q),
  ]);

  const nonWiki: { title: string; url: string; snippet: string }[] = [];
  const wikiCandidates: { title: string; url: string; snippet: string }[] = [];
  const seenUrls = new Set<string>();
  const classify = (item: { title: string; url: string; snippet: string }) => {
    if (!item.url || !item.title) return;
    const normUrl = item.url.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "");
    if (seenUrls.has(normUrl)) return;
    seenUrls.add(normUrl);
    // Classify by DESTINATION, not by which provider returned it — DuckDuckGo (HTML, Lite, and Instant)
    // can incidentally surface a wikipedia.org link as an ordinary general-web result, and that link needs
    // the exact same cap + relevance check as one wikipediaSearch() found directly, or it silently escapes
    // both (see isWikipediaUrl's own doc comment).
    (isWikipediaUrl(item.url) ? wikiCandidates : nonWiki).push(item);
  };

  if (generalSettled.status === "fulfilled") {
    for (const res of generalSettled.value) if (res.status === "fulfilled") for (const item of res.value) classify(item);
  }
  if (wikiSettled.status === "fulfilled") for (const item of wikiSettled.value) classify(item);

  const combined = [...nonWiki];
  // Wikipedia (from ANY source) fills in only up to a small cap, only for a title that actually shares
  // real vocabulary with the query, and only when the general web didn't already fill the list — a
  // genuinely thin result set (an obscure fact, a niche how-to) is exactly when an encyclopedia entry is
  // worth having; a query that already got 6+ real hits doesn't need it too.
  if (combined.length < 6) {
    for (const item of wikiCandidates) {
      if (combined.length - nonWiki.length >= 2) break;
      if (wikiTitleMatchesQuery(item.title, q)) combined.push(item);
    }
  }

  return combined.slice(0, 10);
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
  return items
    .map((item: any) => ({
      title: String(item.title || ""),
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(item.title || "").replace(/ /g, "_"))}`,
      snippet: stripTags(String(item.snippet || "")),
    }))
    .filter((x: any) => x.title && x.snippet && wikiTitleMatchesQuery(x.title, query))
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
