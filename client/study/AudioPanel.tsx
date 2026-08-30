import { useRef, useState } from "react";
import { AUDIO_OPTIONS } from "./StudyMode.tsx";
import { toSpotifyEmbedUrl } from "./spotify.ts";

interface AudioPanelProps {
  audioType: string;
  volume: number;
  playing: boolean;
  customAudioName?: string;
  spotifyEmbedUrl?: string;
  onClose: () => void;
  onChange: (type: string, volume: number, playing: boolean) => void;
  onUploadAudio: (file: File) => void;
  onSetSpotify: (embedUrl: string) => void;
}

export function AudioPanel({ audioType, volume, playing, customAudioName, spotifyEmbedUrl, onClose, onChange, onUploadAudio, onSetSpotify }: AudioPanelProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [spotifyInput, setSpotifyInput] = useState("");
  const [spotifyError, setSpotifyError] = useState("");

  const submitSpotify = () => {
    const embed = toSpotifyEmbedUrl(spotifyInput);
    if (!embed) { setSpotifyError("That doesn't look like a Spotify playlist/album/track link."); return; }
    setSpotifyError("");
    setSpotifyInput("");
    onSetSpotify(embed);
  };
  return (
    <div className="sm-drawer sm-drawer-audio">
      <div className="sm-drawer-header">
        <span>AUDIO</span>
        <button className="sm-drawer-close" onClick={onClose}>×</button>
      </div>
      <div className="sm-drawer-body">
        <div className="sm-audio-tracks">
          <button
            className={`sm-audio-track ${audioType === "silence" ? "active" : ""}`}
            onClick={() => onChange("silence", volume, false)}
          >
            Silence
          </button>
          {AUDIO_OPTIONS.map(opt => (
            <button
              key={opt.id}
              className={`sm-audio-track ${audioType === opt.id ? "active" : ""}`}
              onClick={() => onChange(opt.id, volume, true)}
            >
              {playing && audioType === opt.id ? "▶ " : ""}{opt.label}
            </button>
          ))}
          <button
            className={`sm-audio-track ${audioType === "custom" ? "active" : ""}`}
            onClick={() => customAudioName ? onChange("custom", volume, true) : fileInputRef.current?.click()}
          >
            {playing && audioType === "custom" ? "▶ " : ""}{customAudioName || "Upload your own…"}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="audio/*"
            style={{ display: "none" }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onUploadAudio(f); e.target.value = ""; }}
          />
          {spotifyEmbedUrl && (
            <button
              className={`sm-audio-track ${audioType === "spotify" ? "active" : ""}`}
              onClick={() => onChange("spotify", volume, true)}
            >
              Spotify
            </button>
          )}
        </div>
        {audioType === "custom" && customAudioName && (
          <button className="sm-btn sm-btn-ghost sm-audio-replace" onClick={() => fileInputRef.current?.click()}>
            Replace track
          </button>
        )}

        <div className="sm-audio-spotify">
          <label>Spotify playlist link</label>
          <div className="sm-audio-spotify-row">
            <input
              value={spotifyInput}
              onChange={(e) => setSpotifyInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submitSpotify()}
              placeholder="https://open.spotify.com/playlist/…"
            />
            <button className="sm-btn sm-btn-primary sm-btn-sm" onClick={submitSpotify} disabled={!spotifyInput.trim()}>Add</button>
          </div>
          {spotifyError && <p className="sm-dictionary-error">{spotifyError}</p>}
          {/* Spotify's own official embed widget — it has its own play/pause/volume, so ours don't apply here. */}
          {audioType === "spotify" && spotifyEmbedUrl && (
            <iframe
              className="sm-spotify-embed"
              src={spotifyEmbedUrl}
              width="100%"
              height="152"
              style={{ border: 0, borderRadius: "12px", marginTop: "8px" }}
              allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
              loading="lazy"
              title="Spotify player"
            />
          )}
        </div>

        {audioType !== "silence" && audioType !== "spotify" && (
          <div className="sm-audio-volume">
            <label>Volume</label>
            <input
              type="range"
              min={0}
              max={100}
              value={volume}
              onChange={e => onChange(audioType, Number(e.target.value), playing)}
            />
          </div>
        )}

        {audioType !== "silence" && audioType !== "spotify" && (
          <button
            className="sm-btn sm-btn-ghost"
            onClick={() => onChange(audioType, volume, !playing)}
            style={{ marginTop: "8px" }}
          >
            {playing ? "Pause" : "Play"}
          </button>
        )}
      </div>
    </div>
  );
}
