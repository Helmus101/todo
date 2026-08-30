interface VideoArtifactProps {
  url?: string;
  title: string;
}

export function VideoArtifact({ url, title }: VideoArtifactProps) {
  return (
    <div className="sm-video-body">
      {url ? (
        <iframe
          className="sm-embed"
          src={url}
          title={title}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; picture-in-picture; web-share"
          allowFullScreen
        />
      ) : (
        <div className="sm-artifact-empty">No video attached.</div>
      )}
    </div>
  );
}
