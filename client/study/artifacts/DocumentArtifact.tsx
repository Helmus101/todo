interface DocumentArtifactProps {
  url?: string;
  title: string;
}

// Padlet boards embed via the SAME url with ?embed=true appended (Padlet's own documented embed method —
// no separate widget/oEmbed endpoint needed, unlike Spotify). Matches padlet.com and any custom subdomain
// (padlet's own shortlinks/branded boards live under e.g. <name>.padlet.org too).
const PADLET_RE = /^https:\/\/([a-z0-9-]+\.)?(padlet\.(com|org))\//i;
function toEmbeddableUrl(url: string): string {
  if (PADLET_RE.test(url)) {
    try {
      const u = new URL(url);
      u.searchParams.set("embed", "true");
      return u.toString();
    } catch { return url; }
  }
  return url;
}

export function DocumentArtifact({ url, title }: DocumentArtifactProps) {
  const canEmbed = !!url && (/^https:\/\/docs\.google\.com\//.test(url) || PADLET_RE.test(url));

  return (
    <div className="sm-document-body">
      {canEmbed ? (
        // sandbox WITHOUT allow-top-navigation(-by-user-activation): the embedded page (Google Docs/Padlet)
        // can run its own scripts and open a new tab, but neither it nor a link clicked inside it can ever
        // navigate/redirect the OUTER Otto page to another site — a link "to another app" inside an
        // embedded document must never be able to hijack the tab the student is actually using Otto in.
        <iframe className="sm-embed" src={toEmbeddableUrl(url!)} title={title}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox" />
      ) : url ? (
        <div className="sm-document-reference">
          <strong>{title}</strong>
          <p>This material is attached to the task. A native preview is not available for this file type yet.</p>
          <span className="sm-document-url">{url}</span>
        </div>
      ) : (
        <div className="sm-document-editor">
          <textarea placeholder="Start writing here." />
        </div>
      )}
    </div>
  );
}
