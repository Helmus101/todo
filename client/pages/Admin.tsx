import { useEffect, useState } from "react";
import { api } from "../api.ts";

/** Admin (only the account the server lists as admin): who asked for more AI usage this week, and a button to grant it. */
export function AdminPage() {
  const [rows, setRows] = useState<Awaited<ReturnType<typeof api.adminUsageRequests>>["requests"] | null>(null);
  const [err, setErr] = useState("");
  const [email, setEmail] = useState("");
  const [usd, setUsd] = useState("5");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState("");
  const load = () => { setErr(""); void api.adminUsageRequests().then((r) => setRows(r.requests)).catch((e: any) => setErr(e?.message || "Couldn't load.")); };
  useEffect(load, []);
  const grant = async (to: string, amount: number) => {
    setBusy(true); setDone(""); setErr("");
    try { await api.adminGrantUsage(to, amount); setDone(`Granted $${amount} to ${to} for this week.`); load(); }
    catch (e: any) { setErr(e?.message || "Couldn't grant."); }
    finally { setBusy(false); }
  };
  return (
    <main className="list-wrap admin-page">
      <h1 className="list-head">{"Usage requests"}</h1>
      <p className="page-sub">{"Accounts that used their weekly AI allowance and asked for more. A grant lasts until the end of this week."}</p>
      {err ? <p className="tutor-error" role="alert">{err}</p> : null}
      {done ? <p className="settings-hint" role="status">{done}</p> : null}
      {rows === null ? <p className="muted small">{"Loading…"}</p> : rows.length === 0 ? <p className="settings-hint">{"No open requests."}</p> : (
        <div className="admin-requests">
          {rows.map((r) => (
            <div key={r.email} className="admin-request">
              <div><b translate="no">{r.email}</b><span className="settings-hint">{` · spent $${r.usd.toFixed(2)} this week${r.extraUsd ? ` (+$${r.extraUsd.toFixed(2)} already granted)` : ""} · ${new Date(r.at).toLocaleString()}`}</span>{r.note ? <p className="admin-note">{r.note}</p> : null}</div>
              <div className="admin-actions">{[2, 5, 10].map((n) => <button key={n} type="button" className="btn xs" disabled={busy} onClick={() => void grant(r.email, n)}>{`+$${n}`}</button>)}</div>
            </div>
          ))}
        </div>
      )}
      <section className="settings-sec">
        <h3>{"Grant to an account"}</h3>
        <div className="admin-grant">
          <input className="addinput" type="email" placeholder="email@example.com" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Account email" />
          <input className="addinput" style={{ maxWidth: 90 }} inputMode="decimal" value={usd} onChange={(e) => setUsd(e.target.value)} aria-label="Dollars" />
          <button type="button" className="btn primary" disabled={busy || !email.includes("@") || !(Number(usd) > 0)} onClick={() => void grant(email.trim(), Number(usd))}>{"Grant"}</button>
        </div>
      </section>
    </main>
  );
}
