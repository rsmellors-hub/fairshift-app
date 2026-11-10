import Link from "next/link";
import { money } from "@/app/components/format";
import { StatusBadge } from "@/app/components/product-ui";
import { dateTime } from "@/app/components/workspace-ui";
import { answerPayQueryAction, sendManagerMessageAction } from "@/app/worker-actions";
import type { Scope } from "@/server/auth/access";
import { getDatabase } from "@/server/db/client";
import { locationThreads, managerThread } from "@/server/worker/inbox";
import { openPayQueries, PAY_QUERY_TOPIC_LABEL, type PayQueryTopic, type PayQueryTriage } from "@/server/worker/pay-queries";

// The manager's side of the worker app (design, 10 Nov 2026): messages from the location's workers, and
// workers' questions about a shift's pay with the Pay Agent's triage, answered by the Owner.
export async function WorkerMessages({ scope, thread, timezone }: { scope: Scope; thread?: string; timezone: string }) {
  const db = getDatabase();
  const threads = await locationThreads(db, scope).catch(() => null);
  if (!threads) return null;
  const open = thread && /^[0-9a-f-]{36}$/i.test(thread) ? await managerThread(db, scope, thread).catch(() => null) : null;
  return <section className="panel" id="messages" aria-labelledby="messages-title"><h2 id="messages-title">Messages from your team</h2>
    {threads.length ? <ul className="thread-list">{threads.map(row => <li key={row.workerId}><Link href={`/manager/team?thread=${row.workerId}#messages`} aria-current={open?.worker.id === row.workerId ? "true" : undefined}>
      <strong>{row.name}</strong>{row.unread ? <span className="nav-count">{row.unread}</span> : null}<small>{dateTime(new Date(row.last), timezone)}</small></Link></li>)}</ul>
      : <p className="note">When a worker writes from their Inbox, it shows here. Your reply reaches their Inbox and their email.</p>}
    {open ? <div className="thread-open"><h3>{open.worker.name}</h3>
      <ol className="chat-thread">{open.messages.map(message => <li key={message.id} className={message.fromWorker ? "chat-theirs" : "chat-mine"}><p>{message.body}</p><small>{message.fromWorker ? open.worker.name : message.author ?? "Manager"} · {dateTime(message.createdAt, timezone)}</small></li>)}</ol>
      {scope.demo ? null : <form action={sendManagerMessageAction} className="workspace-form"><input type="hidden" name="workerId" value={open.worker.id} /><label>Reply<textarea name="body" maxLength={1000} required rows={2} /></label><button className="primary-button">Send reply</button></form>}
    </div> : null}
  </section>;
}

export async function PayQueries({ scope, timezone }: { scope: Scope; timezone: string }) {
  const rows = await openPayQueries(getDatabase(), scope).catch(() => null);
  if (!rows?.length) return null;
  return <section className="panel" id="pay-queries" aria-labelledby="pay-queries-title"><h2 id="pay-queries-title">Questions about pay · {rows.length}</h2>
    {rows.map(({ query, workerName, totalMinor, payable }) => { const triage = query.triage as PayQueryTriage;
      return <article className="requirement" key={query.id}>
        <h3>{workerName} · {PAY_QUERY_TOPIC_LABEL[query.topic as PayQueryTopic] ?? query.topic}</h3>
        <p>“{query.message}”</p><p className="note">Asked {dateTime(query.createdAt, timezone)} · shift pay {money(totalMinor, payable.currencyCode)} from the accepted terms</p>
        <p><strong>Pay Agent triage</strong>{triage.payAgent?.model ? <> <StatusBadge tone="predictive">AI</StatusBadge></> : null} <small>from what’s already recorded; no amount can change here</small></p>
        <ul className="pay-agent-checklist">{triage.facts.map(fact => <li key={fact.text}><span aria-hidden="true">{fact.ok === true ? "✓" : fact.ok === false ? "!" : "·"}</span> {fact.text}</li>)}</ul>
        {scope.role === "OWNER" && !scope.demo ? <form action={answerPayQueryAction} className="workspace-form"><input type="hidden" name="queryId" value={query.id} /><label>Your answer (goes to their Inbox and email)<textarea name="answer" maxLength={1000} required rows={2} /></label><button className="primary-button">Send answer</button></form>
          : <p className="note">The Owner answers pay questions.</p>}
      </article>; })}
  </section>;
}
