import { useEffect, useState } from "react";
import { api, type AdminUser, type FeedbackItem } from "../api.ts";

/** Admin-only tools shown at the bottom of Settings: the users list (manual refresh only), full mode per account, feedback review. */
export function AdminTools() {
  const [err, setErr] = useState("");
  const [done, setDone] = useState("");
  const [busy, setBusy] = useState(false);
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [usersAt, setUsersAt] = useState("");
  const [usersBusy, setUsersBusy] = useState(false);
  const [fullEmail, setFullEmail] = useState("");
  const [fb, setFb] = useState<FeedbackItem[] | null>(null);
  const refreshUsers = async () => {
    setUsersBusy(true); setErr("");
    try { const r = await api.adminUsers(); setUsers(r.users); setUsersAt(r.at); }
    catch (e: any) { setErr(e?.message || "Couldn't load the users."); }
    finally { setUsersBusy(false); }
  };
  const flipFull = async (u: AdminUser) => {
    const on = u.fullMode !== true;
    try { await api.adminSetFullAccess(u.email, on); setUsers((prev) => prev && prev.map((x) => (x.email === u.email ? { ...x, fullMode: on } : x))); }
    catch (e: any) { setErr(e?.message || "Couldn't change that account."); }
  };
  const setFull = async (on: boolean) => {
    setBusy(true); setDone(""); setErr("");
    try { await api.adminSetFullAccess(fullEmail.trim(), on); setDone(`${fullEmail.trim()} is now ${on ? "in full mode" : "tutor-only"}.`); }
    catch (e: any) { setErr(e?.message || "Couldn't change that account."); }
    finally { setBusy(false); }
  };
  const loadFb = () => { void api.adminFeedback("pending").then((r) => setFb(r.feedback)).catch(() => setFb([])); };
  useEffect(loadFb, []);
  const decide = async (id: string, d: "approve" | "reject") => { try { await api.adminDecideFeedback(id, d); loadFb(); } catch (e: any) { setErr(e?.message || "Couldn't save the decision."); } };
  return (
    <>
      {err ? <p className="tutor-error" role="alert">{err}</p> : null}
      {done ? <p className="settings-hint" role="status">{done}</p> : null}
      <section className="settings-sec reveal">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <h3>{"All users"}</h3>
          <button type="button" className="btn xs" disabled={usersBusy} onClick={() => void refreshUsers()}>{usersBusy ? "Loading…" : users ? "Refresh" : "Load users"}</button>
        </div>
        <p className="settings-hint">{users ? `${users.length} accounts · updated ${new Date(usersAt).toLocaleTimeString()}. It only refreshes when you press the button, to save database reads.` : "Not loaded. Press the button to read every account once."}</p>
        {users ? (
          <div style={{ overflowX: "auto" }}>
            <table className="admin-users" style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
              <thead><tr style={{ textAlign: "left" }}>{["Account", "Last active", "Sessions", "Voice calls", "Voice min", "Avg min", "Week $", "Month $", "Full"].map((h) => <th key={h} style={{ padding: "6px 8px", fontWeight: 600 }}>{h}</th>)}</tr></thead>
              <tbody>{users.map((u) => (
                <tr key={u.email} style={{ borderTop: "1px solid var(--line, #e5e5e5)" }}>
                  <td style={{ padding: "6px 8px" }}><b translate="no">{u.name || u.email}</b>{u.name ? <div className="settings-hint" translate="no">{u.email}</div> : null}</td>
                  <td style={{ padding: "6px 8px" }}>{u.lastActive ? new Date(u.lastActive).toLocaleDateString() : "–"}</td>
                  <td style={{ padding: "6px 8px" }}>{u.tutorSessions}</td>
                  <td style={{ padding: "6px 8px" }}>{u.voiceCalls}</td>
                  <td style={{ padding: "6px 8px" }}>{u.voiceMinutes}</td>
                  <td style={{ padding: "6px 8px" }}>{u.voiceCalls ? Math.round(u.voiceMinutes / u.voiceCalls) : "–"}</td>
                  <td style={{ padding: "6px 8px" }}>{`$${u.weekUsd.toFixed(2)}`}</td>
                  <td style={{ padding: "6px 8px" }}>{`$${u.monthCostUsd.toFixed(2)}`}</td>
                  <td style={{ padding: "6px 8px" }}><button type="button" className="btn xs ghost" onClick={() => void flipFull(u)}>{u.fullMode === true ? "On" : u.fullMode === false ? "Off" : "Default"}</button></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : null}
      </section>
      <section className="settings-sec reveal">
        <h3>{"Full mode for an account"}</h3>
        <p className="settings-hint">{"Full mode shows the whole app (Today, Journal, Coursework, Mistakes). Without it, the account only sees the tutor. It applies the next time they open Otto."}</p>
        <div className="admin-grant">
          <input className="addinput" type="email" placeholder="email@example.com" value={fullEmail} onChange={(e) => setFullEmail(e.target.value)} aria-label="Account email for full mode" />
          <button type="button" className="btn primary" disabled={busy || !fullEmail.includes("@")} onClick={() => void setFull(true)}>{"Turn on"}</button>
          <button type="button" className="btn ghost" disabled={busy || !fullEmail.includes("@")} onClick={() => void setFull(false)}>{"Turn off"}</button>
        </div>
      </section>
      <section className="settings-sec reveal">
        <h3>{"Feedback waiting for review"}</h3>
        <p className="settings-hint">{"Only quotes whose author agreed to publication can be approved. You see the words and the name they chose, not their email."}</p>
        {fb === null ? <p className="muted small">{"Loading…"}</p> : fb.length === 0 ? <p className="settings-hint">{"Nothing waiting."}</p> : fb.map((f) => (
          <div key={f.id} className="admin-request">
            <div><b>{f.helpful}</b><span className="settings-hint">{` · ${f.publish ? `OK to publish as “${f.name}”${f.level ? `, ${f.level}` : ""}` : "private (not for publication)"}`}</span><p>{f.comment || "(no comment)"}</p></div>
            <div className="admin-actions">
              <button type="button" className="btn xs primary" disabled={!f.publish || !f.comment} onClick={() => void decide(f.id, "approve")}>{"Approve"}</button>
              <button type="button" className="btn xs ghost" onClick={() => void decide(f.id, "reject")}>{f.publish ? "Reject" : "Archive"}</button>
            </div>
          </div>
        ))}
      </section>
    </>
  );
}
