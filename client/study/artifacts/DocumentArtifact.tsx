interface DocumentArtifactProps {
  url?: string;
  title: string;
}

// Padlet boards embed via the SAME url with ?embed=true appended (Padlet's own documented embed method —
// no separate widget/oEmbed endpoint needed, unlike Spotify). Matches padlet.com and any custom subdomain
// (padlet's own shortlinks/branded boards live under e.g. <name>.padlet.org too).
const PADLET_RE = /^https:\/\/([a-z0-9-]+\.)?(padlet\.(com|org))\//i;
// docs.google.com covers every GSuite app (Docs/Sheets/Slides/Forms all live under docs.google.com/<app>/…);
// drive.google.com is the separate domain Drive itself uses for a FILE preview (e.g. a PDF/image uploaded
// to Drive rather than a native Doc) — both need to be recognized as embeddable, not just the first.
const GSUITE_RE = /^https:\/\/docs\.google\.com\//;
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
const canEmbedUrl = (url: string) => GSUITE_RE.test(url) || DRIVE_FILE_RE.test(url) || PADLET_RE.test(url);

export function DocumentArtifact({ url, title }: DocumentArtifactProps) {
  const canEmbed = !!url && canEmbedUrl(url);

  return (
    <div className="sm-document-body">
      {url ? (
        <>
          {canEmbed ? (
            // sandbox WITHOUT allow-top-navigation(-by-user-activation): the embedded page (Google
            // Docs/Drive/Padlet) can run its own scripts and open a new tab, but neither it nor a link
            // clicked inside it can ever navigate/redirect the OUTER Otto page to another site.
            // Also WITHOUT allow-same-origin: combined with allow-scripts, that pairing lets sandboxed
            // content strip its own sandbox — a well-known escape browsers warn about, and Google's
            // Docs/Drive viewer specifically detects it and refuses to render at all ("This content is
            // blocked. Contact the site owner to fix the issue.") rather than serve the document.
            <iframe className="sm-embed" src={toEmbeddableUrl(url)} title={title}
              sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox" />
          ) : (
            <div className="sm-document-reference">
              <strong>{title}</strong>
              <p>This material is attached to the task. A native preview is not available for this file type yet.</p>
            </div>
          )}
          {/* Real, clickable fallback — always rendered, not conditional on the embed failing. A blocked
              Google Doc/Drive file or a Padlet board that refuses to frame (private permissions, an org
              policy, anything outside Otto's control) shows a "blocked" message INSIDE the iframe with no
              JS signal at all (no onError fires) — the student would otherwise be stuck staring at a dead
              pane with no way out. Same pattern PDFArtifact already uses for the same reason. */}
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
