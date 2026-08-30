import { useState, useRef, useEffect } from "react";
import type { WebTask } from "../../shared/types.ts";

interface AskOttoPanelProps {
  chat: { role: "user" | "assistant"; text: string }[];
  onSend: (text: string) => void;
  onClose: () => void;
  task: WebTask;
  currentStep: { text: string } | undefined;
}

export function AskOttoPanel({ chat, onSend, onClose, task, currentStep }: AskOttoPanelProps) {
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat]);

  const send = () => {
    const t = input.trim();
    if (!t) return;
    onSend(t);
    setInput("");
  };

  return (
    <div className="sm-drawer sm-drawer-ai">
      <div className="sm-drawer-header">
        <span>ASK OTTO</span>
        <button className="sm-drawer-close" onClick={onClose}>×</button>
      </div>

      <div className="sm-ai-chat">
        {chat.length === 0 && (
          <p className="sm-ai-empty">
            Ask anything about {currentStep ? `"${currentStep.text}"` : task.title}.
          </p>
        )}
        {chat.map((msg, i) => (
          <div key={i} className={`sm-ai-msg sm-ai-msg-${msg.role}`}>
            <p>{msg.text}</p>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="sm-ai-input-row">
        <input
          className="sm-ai-input"
          type="text"
          placeholder="What do you need help with?"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === "Enter" && send()}
          autoFocus
        />
        <button className="sm-btn sm-btn-primary" onClick={send} disabled={!input.trim()}>
          Send
        </button>
      </div>
    </div>
  );
}
