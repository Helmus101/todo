import React from "react";

const BLOCKED_DOMAINS = [
  "mail.google.com",
  "github.com",
  "stackoverflow.com",
  "notion.so",
  "chatgpt.com",
  "x.com",
  "twitter.com",
  "linkedin.com"
];

function isEmbeddable(url: string) {
  if (!url) return false;
  try {
    const hostname = new URL(url).hostname;
    // Special case for Google search which blocks iframe but can be embedded if we use /search?igu=1 (though maybe too complex for now)
    // We'll just block the known strict ones.
    return !BLOCKED_DOMAINS.some(domain => hostname === domain || hostname.endsWith("." + domain));
  } catch (e) {
    return true;
  }
}

interface WorkspaceIframeProps {
  url?: string;
  title?: string;
  style?: React.CSSProperties;
  className?: string;
}

export function WorkspaceIframe({ url, title, style, className }: WorkspaceIframeProps) {
  if (!url || !isEmbeddable(url)) {
    return (
      <div className={className} style={{ ...style, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", backgroundColor: "var(--bg-secondary)", padding: "24px", textAlign: "center" }}>
        <h3 style={{ marginBottom: "12px", fontSize: "18px", fontWeight: 500 }}>External Resource</h3>
        <p style={{ marginBottom: "24px", color: "var(--text-muted)", maxWidth: "400px", lineHeight: 1.5 }}>
          {url ? `For security reasons, this website (${new URL(url).hostname}) does not allow itself to be embedded inside other apps.` : "No valid URL provided."}
        </p>
        {url && (
          <a href={url} target="_blank" rel="noopener noreferrer" className="btn btn-primary" style={{ textDecoration: "none", display: "inline-block" }}>
            Open {title || "Link"} in New Tab ↗
          </a>
        )}
      </div>
    );
  }

  return (
    // No allow-top-navigation — this embeds an ARBITRARY external URL (only a small blocklist above), so
    // the embedded page (or any link inside it) must never be able to redirect the outer Otto tab.
    <iframe
      src={url}
      className={className}
      style={style}
      title={title || "Workspace Content"}
      allowFullScreen
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
    />
  );
}
