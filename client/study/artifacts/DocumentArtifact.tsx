interface DocumentArtifactProps {
  url?: string;
  title: string;
}

export function DocumentArtifact({ url, title }: DocumentArtifactProps) {
  const canEmbed = !!url && /^https:\/\/docs\.google\.com\//.test(url);

  return (
    <div className="sm-document-body">
      {canEmbed ? (
        <iframe className="sm-embed" src={url} title={title} />
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
