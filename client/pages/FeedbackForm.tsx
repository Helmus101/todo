import { useEffect, useState } from "react";
import { api, type FeedbackItem } from "../api.ts";
import { useNotify } from "../ui.tsx";

const LABEL: Record<FeedbackItem["helpful"], string> = { yes: "Yes, it helped", somewhat: "A bit", no: "Not really" };

/** Settings → Feedback. Sharing feedback is one thing; letting Otto QUOTE it on the website is a second, separate choice
 *  (an unchecked box, with the name you want shown). You can see everything you sent and withdraw any of it. */
export function FeedbackForm() {
  const notify = useNotify();
  const [helpful, setHelpful] = useState<FeedbackItem["helpful"] | null>(null);
  const [comment, setComment] = useState("");
  const [publish, setPublish] = useState(false);
  const [name, setName] = useState("");
  const [level, setLevel] = useState("");
  const [busy, setBusy] = useState(false);
  const [mine, setMine] = useState<FeedbackItem[]>([]);
  const load = () => { void api.myFeedback().then((r) => setMine(r.feedback)).catch(() => {}); };
  useEffect(load, []);
  const send = async () => {
    if (!helpful) return;
    setBusy(true);
    try {
      await api.sendFeedback({ helpful, comment, publish, ...(publish ? { name, level } : {}) });
      setHelpful(null); setComment(""); setPublish(false); setName(""); setLevel("");
      notify(publish ? "Thank you. Your quote will only appear after it has been reviewed." : "Thank you for the feedback.");
      load();
    } catch (e: any) { notify(e?.message || "Couldn't send that — try again.", "error"); }
    finally { setBusy(false); }
  };
  const withdraw = async (id: string) => {
    try { await api.withdrawFeedback(id); load(); notify("Removed."); }
    catch (e: any) { notify(e?.message || "Couldn't remove that.", "error"); }
  };
  return (
    <div className="feedback-form">
      <p className="settings-hint">{"Did Otto help you learn? Honest answers only; this is how Otto gets better."}</p>
      <div className="feedback-choices" role="radiogroup" aria-label="Did Otto help?">
        {(Object.keys(LABEL) as FeedbackItem["helpful"][]).map((k) => (
          <button key={k} type="button" role="radio" aria-checked={helpful === k} className={`btn xs${helpful === k ? " primary" : " ghost"}`} onClick={() => setHelpful(k)}>{LABEL[k]}</button>
        ))}
      </div>
      <textarea className="addinput" rows={3} maxLength={600} placeholder="What worked, what didn't? (optional)" aria-label="Your feedback" value={comment} onChange={(e) => setComment(e.target.value)} />
      <label className="feedback-consent">
        <input type="checkbox" checked={publish} onChange={(e) => setPublish(e.target.checked)} />
        <span>{"You may quote my words on Otto's website. I can withdraw this at any time here, and it ends if I delete my account."}</span>
      </label>
      {publish ? (
        <div className="feedback-publish">
          <input className="addinput" maxLength={30} placeholder="Name to show (a first name or initial)" aria-label="Name to show next to the quote" value={name} onChange={(e) => setName(e.target.value)} />
          <input className="addinput" maxLength={40} placeholder="Year or programme, e.g. Year 12 IB (optional)" aria-label="Year or programme to show" value={level} onChange={(e) => setLevel(e.target.value)} />
          <p className="settings-hint">{"Shown only after review. Your email is never shown."}</p>
        </div>
      ) : null}
      <button type="button" className="btn primary" disabled={busy || !helpful || (publish && (comment.trim().length < 10 || !name.trim()))} onClick={() => void send()}>{busy ? "Sending…" : "Send feedback"}</button>
      {mine.length > 0 ? (
        <div className="feedback-mine">
          <h4>{"What you've sent"}</h4>
          <ul>
            {mine.map((f) => (
              <li key={f.id}>
                <span className="settings-hint">{`${LABEL[f.helpful]}${f.comment ? ` — “${f.comment}”` : ""} · ${f.publish ? (f.status === "approved" ? "shown on the website" : f.status === "rejected" ? "not published" : "waiting for review") : "private"}`}</span>
                <button type="button" className="btn xs ghost" onClick={() => void withdraw(f.id)}>{f.publish && f.status === "approved" ? "Withdraw and remove" : "Delete"}</button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
