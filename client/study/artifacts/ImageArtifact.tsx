interface ImageArtifactProps {
  url?: string;
  title: string;
}

export function ImageArtifact({ url, title }: ImageArtifactProps) {
  return (
    <div className="sm-image-body">
      {url ? <img src={url} alt={title} /> : <div className="sm-artifact-empty">No image attached.</div>}
    </div>
  );
}
