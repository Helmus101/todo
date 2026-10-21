import { useEffect, useState } from "react";
import { api } from "../api.ts";

type Ctx = Awaited<ReturnType<typeof api.pronoteContext>>;

/** What Pronote currently gives Otto: the cahier de texte (homework and tests with the teachers' instructions) and the contenu des cours (lesson
 *  content and files). It is exactly what the tutor is told, so the student can check it. */
export function PronoteContext() {
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState("");
  const load = (fresh = false) => { setBusy(true); setErr(""); void api.pronoteContext(fresh).then(setCtx).catch((e: any) => setErr(e?.message || "Couldn't read Pronote.")).finally(() => setBusy(false)); };
  useEffect(() => load(), []);
  const day = (iso: string) => String(iso || "").slice(0, 10);
  return (
    <div className="pronote-context">
      <div className="pronote-context-head">
        <b>{"What Otto sees from Pronote"}</b>
        <button type="button" className="btn xs ghost" disabled={busy} onClick={() => load(true)}>{busy ? "Reading…" : "Refresh"}</button>
      </div>
      {err ? <p className="settings-hint" role="alert">{err}</p> : null}
      {ctx && ctx.connected ? (
        <>
          <details>
            <summary>{`Cahier de texte (${ctx.homework.length})`}</summary>
            {ctx.homework.length === 0 ? <p className="settings-hint">{"No open homework or tests right now."}</p> : ctx.homework.map((h) => (
              <div key={h.id} className="pronote-item"><b translate="no">{h.subject}</b><span>{` · due ${day(h.deadline)}`}</span>{h.text ? <p translate="no">{h.text}</p> : null}{h.files.length ? <small translate="no">{`Files: ${h.files.join(", ")}`}</small> : null}</div>
            ))}
          </details>
          <details>
            <summary>{`Contenu des cours (${ctx.lessons.length})`}</summary>
            {ctx.lessons.length === 0 ? <p className="settings-hint">{"No lesson content published recently."}</p> : ctx.lessons.map((l) => (
              <div key={l.id} className="pronote-item"><b translate="no">{l.subject}</b><span>{` · ${day(l.date)}${l.category ? ` · ${l.category}` : ""}`}</span>{l.title ? <p translate="no"><b>{l.title}</b></p> : null}{l.text ? <p translate="no">{l.text}</p> : null}{l.files.length ? <small translate="no">{`Files: ${l.files.join(", ")}`}</small> : null}</div>
            ))}
          </details>
        </>
      ) : null}
    </div>
  );
}
