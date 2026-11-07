"use client";

import { useEffect, useRef, useState } from "react";
import { loadStatementAction, updateDestinationAction } from "@/app/staff-actions";

type Statement = NonNullable<Extract<Awaited<ReturnType<typeof loadStatementAction>>, { statement: unknown }>["statement"]>;
const rand = (minor: number) => `R${(minor / 100).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (value: string | Date) => new Date(value).toLocaleString("en-ZA", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Johannesburg" });

// A permanent staff member's own tip statement. The token is read from the URL fragment, which
// browsers never send to the server, and is removed from the address bar once read.
export function StatementClient() {
  const [token, setToken] = useState<string | null>(null);
  const [statement, setStatement] = useState<Statement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  // The fragment is read exactly once, even when React runs this effect twice in development.
  const captured = useRef<string | null>(null);
  useEffect(() => {
    if (captured.current === null) {
      captured.current = window.location.hash.slice(1);
      history.replaceState(null, "", window.location.pathname);
    }
    const value = captured.current;
    setToken(value);
    void loadStatementAction(value).then(result => "statement" in result ? setStatement(result.statement as Statement) : setError(result.error));
  }, []);
  if (error) return <p className="form-alert" role="alert">{error}</p>;
  if (!statement || !token) return <p>Loading your statement…</p>;
  const act = async (action: "CONFIRM" | "CHANGE", email?: string) => {
    const result = await updateDestinationAction(token, action, email);
    if ("error" in result) { setNotice(result.error ?? null); return; }
    setNotice(action === "CHANGE" ? "Your PayPal account was changed. Your employer must release payments to it for the next 24 hours." : "Thank you: your PayPal account is confirmed.");
    const next = await loadStatementAction(token);
    if ("statement" in next) setStatement(next.statement as Statement);
  };
  return <div className="statement">
    <h1>Your tips, {statement.firstName}</h1>
    <p className="panel-lede">{statement.business} · {statement.location}. {statement.policy} Amounts are calculated by FairShift from imported point-of-sale records; nobody can edit them.</p>
    <section className="panel"><h2>Credited tips</h2>
      {statement.credits.length ? <ul className="statement-credits">{statement.credits.map((credit, index) => <li key={index}><strong>{rand(credit.shareMinor)}</strong> · {credit.date} · {credit.block} · <span className={`status-${credit.status.replace(" ", "-")}`}>{credit.status}</span></li>)}</ul> : <p>No tips have been credited to you yet.</p>}
      <p className="note">Recorded: calculated, not yet released. Under review: your employer is checking it. Released: sent through PayPal, not yet confirmed. Paid: PayPal confirmed the payment.</p>
    </section>
    {statement.holds.length ? <section className="panel"><h2>Checks on your tips</h2><ul>{statement.holds.map((hold, index) => <li key={index}>{when(hold.at)} · {hold.reason}{hold.decisions.map((decision, n) => <div key={n}><small>{when(decision.at)} · {decision.outcome}: “{decision.reason}”</small></div>)}</li>)}</ul></section> : null}
    <section className="panel"><h2>Your PayPal account</h2>
      <p>{statement.destination.masked ?? "No PayPal account recorded"} · {statement.destination.confirmed ? "confirmed" : "not confirmed yet"}</p>
      {statement.destination.changeAvailable ? <>
        {statement.destination.confirmed ? null : <button className="secondary-button" onClick={() => act("CONFIRM")}>This is my PayPal account</button>}
        {changing ? <form onSubmit={event => { event.preventDefault(); const email = new FormData(event.currentTarget).get("email"); void act("CHANGE", String(email ?? "")); }} className="inline-form">
          <label>New PayPal email<input name="email" type="email" required /></label><button className="secondary-button">Use this account</button></form>
          : <button className="text-button" onClick={() => setChanging(true)}>Use a different PayPal account</button>}
      </> : <p className="note">This link has already been used for your PayPal account. Ask your employer for a new link to change it.</p>}
      {notice ? <p className="note" role="status">{notice}</p> : null}
    </section>
    <p className="note">This link expires {when(statement.expiresAt)}. It shows only your own tips.</p>
  </div>;
}
