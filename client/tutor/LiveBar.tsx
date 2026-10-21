import { useState } from "react";
import { ArrowUp, History, Keyboard, Mic, MicOff, PhoneOff, Play } from "lucide-react";
import type { LiveStatus } from "./live/useGeminiLive.ts";

/** The voice bar under the board: Otto's presence, one line of what is being said, and the few controls a call needs. Typing is a
 *  small side door, not the main way in. */
export function LiveBar(p: {
  status: LiveStatus;
  speaking: boolean;
  thinking: boolean;
  muted: boolean;
  caption: { who: "you" | "otto"; text: string } | null;
  error: string | null;
  sending: boolean;
  onStart: () => void;
  onStop: () => void;
  onMute: (m: boolean) => void;
  onType: (text: string) => void;
  onHistory: () => void;
  historyCount: number;
  /** The browser is holding the voice back until a tap (like Socra's play button). */
  blocked?: boolean;
  onResume?: () => void;
}) {
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState("");
  const live = p.status === "live";
  const connecting = p.status === "connecting";
  const mood = p.thinking || p.sending ? "thinking" : p.speaking ? "speaking" : live && !p.muted ? "listening" : "idle";
  const line = p.error ? p.error
    : connecting ? "Connecting…"
    : p.thinking || p.sending ? "Thinking it through…"
    : p.caption?.text ? (p.caption.who === "you" ? `“${p.caption.text.slice(-200)}”` : p.caption.text.slice(-240))
    : live ? (p.muted ? "Muted" : "Listening…")
    : "Tap the mic and talk to Otto";
  const submit = () => { const t = text.trim(); if (!t) return; setText(""); setTyping(false); p.onType(t); };
  return (
    <div className="live-bar" data-state={mood}>
      <div className="live-bar-main">
        <span className="live-orb" aria-hidden="true" style={live || connecting ? { width: 72, height: 72 } : undefined} />
        <p className={`live-caption${p.error ? " is-error" : ""}${p.caption?.who === "you" && !p.thinking ? " is-you" : ""}`} role="status" aria-live="polite">{line}</p>
      </div>
      {typing ? (
        <div className="live-type">
          <input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Type to Otto…" aria-label="Type to Otto" onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") setTyping(false); }} />
          <button type="button" className="live-icon-btn" onClick={submit} disabled={!text.trim() || p.sending} aria-label="Send"><ArrowUp size={16} aria-hidden="true" /></button>
        </div>
      ) : null}
      <div className="live-controls">
        {live ? <button type="button" className="live-icon-btn" onClick={() => p.onMute(!p.muted)} aria-pressed={p.muted} aria-label={p.muted ? "Unmute" : "Mute"} title={p.muted ? "Unmute" : "Mute"}>{p.muted ? <MicOff size={18} aria-hidden="true" /> : <Mic size={18} aria-hidden="true" />}</button> : null}
        <button type="button" className={`live-main-btn${live || connecting ? " is-on" : ""}`} onClick={live || connecting ? p.onStop : p.onStart} disabled={p.status === "unavailable"} aria-pressed={live}>
          {live || connecting ? <PhoneOff size={18} aria-hidden="true" /> : <Mic size={18} aria-hidden="true" />}
          <span>{connecting ? "Cancel" : live ? "Voice on" : "Voice mode"}</span>
        </button>
        {p.blocked ? <button type="button" className="live-icon-btn live-play" onClick={p.onResume} aria-label="Play Otto's voice" title="Play Otto's voice"><Play size={18} aria-hidden="true" /></button> : null}
        <button type="button" className="live-icon-btn" onClick={() => setTyping((t) => !t)} aria-pressed={typing} aria-label="Type instead" title="Type instead"><Keyboard size={18} aria-hidden="true" /></button>
        <button type="button" className="live-icon-btn" onClick={p.onHistory} aria-label="Conversation" title="Conversation"><History size={18} aria-hidden="true" />{p.historyCount ? <span className="live-count">{p.historyCount}</span> : null}</button>
      </div>
    </div>
  );
}
