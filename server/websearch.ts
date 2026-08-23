/**
 * Web search for the task agents (generate/run) to pull in external context — a person, a deadline,
 * a how-to, a link. Backed by DuckDuckGo's HTML endpoint; no API key needed, best-effort.
 */

/** Web search → [{title,url,snippet}]. Never throws — returns [] on any failure. */
export async function webSearch(query: string): Promise<{ title: string; url: string; snippet: string }[]> {
  if (!query.trim()) return [];
  return duckDuckGo(query).catch(() => []);
}

async function duckDuckGo(query: string): Promise<{ title: string; url: string; snippet: string }[]> {
  if (!query.trim()) return [];
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" },
    // Without a timeout, a stalled DDG response hangs whatever called webSearch indefinitely — a whole
    // sweep/generate call included, since it awaits this directly. The resulting AbortError is just
    // another failure to the caller above (webSearch's own .catch(() => [])), so no special-casing needed.
    signal: AbortSignal.timeout(9000),
  });
  if (!res.ok) throw new Error(`ddg ${res.status}`);
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
    // Only advance the snippet index for an entry actually pushed — result__a and result__snippet are
    // matched by two independent regexes with no guaranteed 1:1 correspondence, so incrementing on every
    // match (including filtered-out ones) misaligned a later result with the WRONG snippet.
    if (url && title) { out.push({ title, url, snippet: snippets[i] || "" }); i++; }
  }
  return out;
}

const stripTags = (s: string) => s
  .replace(/<[^>]+>/g, "")
  .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
  .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
  .replace(/\s+/g, " ").trim();

function decodeDdgUrl(href: string): string {
  // DDG wraps results as //duckduckgo.com/l/?uddg=<encoded real url>&...
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (m) { try { return decodeURIComponent(m[1]); } catch { /* fall through */ } }
  return href.startsWith("//") ? "https:" + href : href;
}
