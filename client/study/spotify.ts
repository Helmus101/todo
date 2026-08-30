// Turns a pasted Spotify link into Spotify's own official embed URL — no OAuth, no API key, no Premium
// requirement: this is the same public iframe widget Spotify offers for embedding on any website.
// Accepts playlist/album/track links, with or without an "intl-xx" locale segment, and raw spotify: URIs.
const SPOTIFY_RE = /open\.spotify\.com\/(?:intl-[a-z-]+\/)?(playlist|album|track)\/([a-zA-Z0-9]+)/;
const SPOTIFY_URI_RE = /^spotify:(playlist|album|track):([a-zA-Z0-9]+)$/;

export function toSpotifyEmbedUrl(input: string): string | null {
  const trimmed = input.trim();
  const m = trimmed.match(SPOTIFY_RE) || trimmed.match(SPOTIFY_URI_RE);
  if (!m) return null;
  const [, kind, id] = m;
  return `https://open.spotify.com/embed/${kind}/${id}?utm_source=generator`;
}
