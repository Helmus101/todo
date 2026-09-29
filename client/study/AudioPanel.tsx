import { useRef, useState } from "react";
import { AUDIO_OPTIONS } from "./StudyMode.tsx";
import { toSpotifyEmbedUrl } from "./spotify.ts";
import { useSmClose, SmSurface, useLang } from "../ui.tsx";

interface AudioPanelProps {
  audioType: string;
  volume: number;
  playing: boolean;
  customAudioName?: string;
  spotifyEmbedUrl?: string;
  /** Whether the drawer is CURRENTLY meant to be visible — this component stays mounted even while hidden
   *  when Spotify is active (see StudyMode.tsx), so it needs its own signal to reset the one-shot close
   *  animation latch on reopen; see useSmClose's `reopenKey` param. */
  open: boolean;
  onClose: () => void;
  onChange: (type: string, volume: number, playing: boolean) => void;
  onUploadAudio: (file: File) => void;
  onSetSpotify: (embedUrl: string) => void;
}

export function AudioPanel({ audioType, volume, playing, customAudioName, spotifyEmbedUrl, open, onClose, onChange, onUploadAudio, onSetSpotify }: AudioPanelProps) {
  const L = useLang();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [spotifyInput, setSpotifyInput] = useState("");
  const [spotifyError, setSpotifyError] = useState("");

  const submitSpotify = () => {
    const embed = toSpotifyEmbedUrl(spotifyInput);
    if (!embed) { setSpotifyError(L("Ça ne ressemble pas à un lien Spotify (playlist, album ou titre).", "That doesn't look like a Spotify playlist/album/track link.")); return; }
    setSpotifyError("");
    setSpotifyInput("");
    onSetSpotify(embed);
  };
  const { closing, doClose } = useSmClose(onClose, 240, open);
  return (
    <SmSurface variant="drawer" closing={closing} className="sm-drawer sm-drawer-audio">
      <div className="sm-drawer-header">
        <span>AUDIO</span>
        <button className="sm-drawer-close" onClick={doClose}>×</button>
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
              {playing && audioType === opt.id ? "▶ " : ""}{L(opt.label[0], opt.label[1])}
            </button>
          ))}
          <button
            className={`sm-audio-track ${audioType === "custom" ? "active" : ""}`}
            onClick={() => customAudioName ? onChange("custom", volume, true) : fileInputRef.current?.click()}
          >
            {playing && audioType === "custom" ? "▶ " : ""}{customAudioName || L("Ajouter ta propre musique…", "Upload your own…")}
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
            {L("Remplacer le morceau", "Replace track")}
          </button>
        )}

        <div className="sm-audio-spotify">
          <label>{L("Lien de playlist Spotify", "Spotify playlist link")}</label>
          <div className="sm-audio-spotify-row">
            <input
              value={spotifyInput}
              onChange={(e) => setSpotifyInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submitSpotify()}
              placeholder="https://open.spotify.com/playlist/…"
            />
            <button className="sm-btn sm-btn-primary sm-btn-sm" onClick={submitSpotify} disabled={!spotifyInput.trim()}>{L("Ajouter", "Add")}</button>
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
              // No allow-top-navigation — the widget (or a link inside it, e.g. an artist/album page) must
              // never be able to redirect the outer Otto tab to open.spotify.com or anywhere else.
              sandbox="allow-scripts allow-same-origin allow-popups"
            />
          )}
        </div>

        {audioType !== "silence" && audioType !== "spotify" && (
          <div className="sm-audio-volume">
            <label>{L("Volume", "Volume")}</label>
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
            {playing ? L("Pause", "Pause") : L("Lecture", "Play")}
          </button>
        )}
      </div>
    </SmSurface>
  );
}
