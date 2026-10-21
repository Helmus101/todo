// Safe reading of untrusted web pages: a byte-capped body read and a linear-time HTML→text pass.
// The old lazy regexes (/<script[\s\S]*?<\/script>/) go quadratic on hostile pages (thousands of unclosed
// "<script"), blocking the event loop for every other request on the instance; this scans once with indexOf.

/** Read at most `maxBytes` of a fetch Response body (decoded as UTF-8), then stop downloading. */
export async function readBodyCapped(res: Response, maxBytes = 400_000): Promise<string> {
  if (!res.body) return (await res.text()).slice(0, maxBytes);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).subarray(0, maxBytes).toString("utf8");
}

const BLOCK_TAGS = new Set(["p", "div", "li", "tr", "br", "h1", "h2", "h3", "h4", "h5", "h6"]);

/** HTML → plain text in one pass. `drop` lists elements whose whole content is discarded. */
export function htmlToPlainText(html: string, drop: string[] = ["script", "style", "noscript"]): string {
  const lower = html.toLowerCase();
  const dropSet = new Set(drop);
  let out = "";
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) { out += html.slice(i); break; }
    out += html.slice(i, lt);
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      if (end === -1) break;
      out += " "; i = end + 3; continue;
    }
    const gt = html.indexOf(">", lt + 1);
    if (gt === -1) break; // an unterminated tag: drop the rest rather than emit raw markup
    const m = /^<(\/?)([a-z][a-z0-9]*)/.exec(lower.slice(lt, lt + 24));
    if (!m) { out += " "; i = gt + 1; continue; }
    const closing = m[1] === "/", name = m[2];
    if (!closing && dropSet.has(name)) {
      const close = lower.indexOf(`</${name}`, gt + 1);
      if (close === -1) break; // never closed: the rest is all inside the element
      const closeEnd = html.indexOf(">", close);
      out += " "; i = closeEnd === -1 ? n : closeEnd + 1; continue;
    }
    out += closing && BLOCK_TAGS.has(name) || name === "br" ? "\n" : " ";
    i = gt + 1;
  }
  return out
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n")
    .trim();
}
