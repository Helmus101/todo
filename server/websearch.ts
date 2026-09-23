/**
 * Web search for task agents and study help — parallelized multi-provider search engine.
 * Queries DuckDuckGo HTML, DuckDuckGo Lite, Wikipedia REST API, and DDG Instant Answer concurrently
 * via Promise.allSettled. Fast, resilient, keyless, and deduplicated.
 */

export async function webSearch(query: string): Promise<{ title: string; url: string; snippet: string }[]> {
  const q = query.trim();
  if (!q) return [];

  // Run all search providers concurrently
  const settled = await Promise.allSettled([
    duckDuckGoHtml(q),
    duckDuckGoLite(q),
    wikipediaSearch(q),
    duckDuckGoInstant(q),
  ]);

  const combined: { title: string; url: string; snippet: string }[] = [];
  const seenUrls = new Set<string>();

  for (const res of settled) {
    if (res.status === "fulfilled" && Array.isArray(res.value)) {
      for (const item of res.value) {
        if (!item.url || !item.title) continue;
        const normUrl = item.url.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "");
        if (seenUrls.has(normUrl)) continue;
        seenUrls.add(normUrl);
        combined.push(item);
      }
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
  return items.slice(0, 4).map((item: any) => ({
    title: String(item.title || ""),
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(item.title || "").replace(/ /g, "_"))}`,
    snippet: stripTags(String(item.snippet || "")),
  })).filter((x: any) => x.title && x.snippet);
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
