interface DocumentArtifactProps {
  url?: string;
  title: string;
}

// Padlet boards embed via the SAME url with ?embed=true appended (Padlet's own documented embed method —
// no separate widget/oEmbed endpoint needed, unlike Spotify). Matches padlet.com and any custom subdomain
// (padlet's own shortlinks/branded boards live under e.g. <name>.padlet.org too).
const PADLET_RE = /^https:\/\/([a-z0-9-]+\.)?(padlet\.(com|org))\//i;
// drive.google.com is the domain Drive uses for a FILE preview (e.g. a PDF/image uploaded to Drive rather
// than a native Doc) — docs.google.com (every GSuite app: Docs/Sheets/Slides/Forms) needs no transform at
// all, it's embeddable as-is, same as any other generic URL now (see isHttpUrl below).
const DRIVE_FILE_RE = /^https:\/\/drive\.google\.com\/file\/d\/([^/]+)\//;
function toEmbeddableUrl(url: string): string {
  if (PADLET_RE.test(url)) {
    try {
      const u = new URL(url);
      u.searchParams.set("embed", "true");
      return u.toString();
    } catch { return url; }
  }
  // A normal shared Drive link is .../file/d/<id>/view — Drive refuses to frame that path at all. The
  // embeddable form is .../file/d/<id>/preview, same file, no permissions change needed on the student's end.
  const m = url.match(DRIVE_FILE_RE);
  if (m) return `https://drive.google.com/file/d/${m[1]}/preview`;
  return url;
}
// Any http(s) URL is now WORTH TRYING to embed, not just the three hosts above — those get a special
// embed-friendly URL transform (Padlet's ?embed=true, Drive's /preview path), but a generic site (a course
// page, a Wikipedia article, a school's own portal, anything) is at least attempted in an iframe instead of
// immediately punting to "no preview available" for every host that isn't Google/Padlet. Some sites refuse
// to be framed at all (X-Frame-Options/CSP frame-ancestors — entirely the SITE's choice, nothing Otto can
// override) and render blank with no JS-visible error either way — the always-present "Open in a new tab"
// link below is precisely the escape hatch for that case, same as it already was for a blocked Google Doc.
function isHttpUrl(url: string): boolean {
  try { const u = new URL(url); return u.protocol === "http:" || u.protocol === "https:"; } catch { return false; }
}

// Google's Docs/Drive viewer specifically DETECTS the allow-scripts+allow-same-origin combination (the
// well-known sandbox-escape pairing) and refuses to render at all when both are present ("This content is
// blocked. Contact the site owner to fix the issue.") — so the stricter, allow-same-origin-less sandbox
// must stay for Google's own domains specifically, even though every OTHER site gets allow-same-origin
// below for real compatibility (see the iframe's own comment).
const GOOGLE_DOCS_HOST_RE = /^https:\/\/(docs|drive)\.google\.com\//i;

export function DocumentArtifact({ url, title }: DocumentArtifactProps) {
  const canEmbed = !!url && isHttpUrl(url);
  const isGoogleDocsHost = !!url && GOOGLE_DOCS_HOST_RE.test(url);

  return (
    <div className="sm-document-body">
      {url ? (
        <>
          {canEmbed ? (
            // sandbox WITHOUT allow-top-navigation(-by-user-activation): the embedded page can run its own
            // scripts and open a new tab, but neither it nor a link clicked inside it can ever navigate/
            // redirect the OUTER Otto page to another site. That guarantee holds regardless of the
            // allow-same-origin choice below, since top-navigation is withheld either way.
            //
            // allow-same-origin: included for every site EXCEPT Google Docs/Drive (see GOOGLE_DOCS_HOST_RE's
            // own comment — their viewer refuses to render at all if it detects allow-scripts+allow-same-
            // origin together). Without it, a sandboxed page has no origin of its own at all (an opaque
            // "null" origin) — cookies, localStorage, and any same-origin API call silently fail, which is
            // why most ordinary sites (course pages, Wikipedia, school portals — anything beyond the
            // specifically-tested Padlet/Drive cases) never fully loaded. The residual risk this reopens is
            // a malicious embedded site escaping ITS OWN sandbox restrictions — real, but bounded: it still
            // can never navigate/redirect the outer Otto page (allow-top-navigation is never granted), so
            // the attack surface is "misbehaves within its own frame," not "attacks Otto directly."
            <iframe className="sm-embed" src={toEmbeddableUrl(url)} title={title}
              sandbox={`allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox${isGoogleDocsHost ? "" : " allow-same-origin"}`} />
          ) : (
            <div className="sm-document-reference">
              <strong>{title}</strong>
              <p>This material is attached to the task. A native preview is not available for this file type yet.</p>
            </div>
          )}
          {/* Real, clickable fallback — always rendered, not conditional on the embed failing. A site that
              refuses to be framed (private permissions, an org policy, X-Frame-Options, anything outside
              Otto's control) shows blank/a "blocked" message INSIDE the iframe with no JS signal at all (no
              onError fires) — the student would otherwise be stuck staring at a dead pane with no way out.
              Same pattern PDFArtifact already uses for the same reason. */}
          <a className="sm-document-fallback-link" href={url} target="_blank" rel="noopener noreferrer">
            {canEmbed ? "Not loading? Open in a new tab ↗" : `Open ${title} in a new tab ↗`}
          </a>
        </>
      ) : (
        <div className="sm-document-editor">
          <textarea placeholder="Start writing here." />
        </div>
      )}
    </div>
  );
}
