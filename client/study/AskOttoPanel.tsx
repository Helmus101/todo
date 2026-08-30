import { useRef, useEffect } from "react";
import type { WebTask } from "../../shared/types.ts";
import { renderChatText } from "../ui.tsx";

interface AskOttoPanelProps {
  task: WebTask;
  currentStep: { text: string } | undefined;
  input: string;
  setInput: (v: string) => void;
  sending: boolean;
  error: string | null;
  pendingMsg: string | null;
  slow: boolean;
  verySlow: boolean;
  onSend: () => void;
  onClose: () => void;
  onOpenNote: (id: string, title: string) => void;
  onOpenDeck: (id: string, title: string) => void;
  onOpenQuiz: (id: string, title: string) => void;
}

// Mirrors TaskCard.tsx's TaskChat exactly (same pending-echo/typing-dots/slow-hint/error-retry state
// machine, same markdown rendering) — a student should get the identical tutoring experience whether
// they're on the main task card or inside Study Mode, not a stripped-down copy.
export function AskOttoPanel({
  task, currentStep, input, setInput, sending, error, pendingMsg, slow, verySlow, onSend, onClose,
  onOpenNote, onOpenDeck, onOpenQuiz,
}: AskOttoPanelProps) {
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [task.chat?.length, sending]);

  return (
    <div className="sm-drawer sm-drawer-ai">
      <div className="sm-drawer-header">
        <span>ASK OTTO</span>
        <button className="sm-drawer-close" onClick={onClose}>×</button>
      </div>

      <div className="sm-ai-chat" role="log" aria-live="polite" aria-label="Conversation with Otto">
        {!task.chat?.length && !pendingMsg ? (
          <p className="sm-ai-empty">
            Ask anything about {currentStep ? `"${currentStep.text}"` : task.title}.
          </p>
        ) : task.chat?.map((m, i) => (
          <div key={i} className={`sm-ai-msg sm-ai-msg-${m.role}`}>
            <span className={`sm-ai-sender sm-ai-sender-${m.role}`}>{m.role === "user" ? "You" : "Otto"}</span>
            {m.role === "user" && m.stepText ? <span className="sm-ai-step-tag">Step {(m.stepIndex ?? 0) + 1} · {m.stepText}</span> : null}
            {/* renderChatText returns its own <p>/<ul> blocks — must NOT be wrapped in another <p> (invalid
                nesting silently breaks paragraph spacing, browsers auto-close the outer tag). */}
            {m.role === "assistant" ? renderChatText(m.text) : <p>{m.text}</p>}
            {m.artifacts?.length ? (
              <div className="sm-ai-artifact-chips">
                {m.artifacts.map((a) => {
                  const exists = a.kind === "note" ? task.notes?.some((n) => n.id === a.id)
                    : a.kind === "deck" ? task.flashcards?.some((f) => f.id === a.id)
                    : task.quizzes?.some((q) => q.id === a.id);
                  if (!exists) return null;
                  const open = a.kind === "note" ? onOpenNote : a.kind === "deck" ? onOpenDeck : onOpenQuiz;
                  return <button key={a.id} type="button" className="sm-btn sm-btn-ghost sm-btn-sm" onClick={() => open(a.id, a.title)}>{a.title}</button>;
                })}
              </div>
            ) : null}
            {m.role === "assistant" && m.guardrail ? (
              <span className="sm-ai-guardrail-tag">Otto guides, doesn't do it for you</span>
            ) : null}
          </div>
        ))}
        {pendingMsg ? <div className="sm-ai-msg sm-ai-msg-user sm-ai-msg-pending">{pendingMsg}</div> : null}
        {sending ? (
          <div className="sm-ai-msg sm-ai-msg-assistant sm-ai-typing" role="status" aria-label="Otto is thinking">
            <span className="sm-typing-dots" aria-hidden="true"><i /><i /><i /></span>
            {verySlow ? <span className="sm-typing-slow">might be putting something together…</span>
              : slow ? <span className="sm-typing-slow">still thinking…</span> : null}
          </div>
        ) : null}
        <div ref={endRef} />
      </div>

      {error ? (
        <div className="sm-ai-error">
          {error}
          <button type="button" className="sm-btn sm-btn-ghost sm-btn-sm" onClick={onSend} disabled={sending}>Retry</button>
        </div>
      ) : null}

      <div className="sm-ai-input-row">
        <input
          ref={inputRef}
          className="sm-ai-input"
          type="text"
          aria-label="Your message to Otto"
          placeholder="What do you need help with?"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); onSend(); } }}
          disabled={sending}
          autoFocus
        />
        <button className="sm-btn sm-btn-primary" onClick={onSend} disabled={sending || !input.trim()}>
          Send
        </button>
      </div>
    </div>
  );
}
