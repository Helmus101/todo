interface VideoArtifactProps {
  url?: string;
  title: string;
}

export function VideoArtifact({ url, title }: VideoArtifactProps) {
  return (
    <div className="sm-video-body">
      {url ? (
        // No allow-top-navigation — the player itself (or a link/end-card inside it) must never be able to
        // redirect the outer Otto tab to another site.
        <iframe
          className="sm-embed"
          src={url}
          title={title}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; picture-in-picture; web-share"
          allowFullScreen
          sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
        />
      ) : (
        <div className="sm-artifact-empty">No video attached.</div>
      )}
    </div>
  );
}
