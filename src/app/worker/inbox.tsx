import Link from "next/link";
import { sendWorkerMessageAction } from "@/app/worker-actions";
import { dateTime } from "@/app/components/workspace-ui";
import { QUICK_MESSAGES, type workerInbox } from "@/server/worker/inbox";

// The worker's Inbox (design, 10 Nov 2026): one record of offers, bookings, cancellations and payments,
// newest first (each was also emailed), and the conversation with the location's managers.
type Inbox = Awaited<ReturnType<typeof workerInbox>>;
const KIND: Record<string, string> = { SHIFT_OFFER: "Offer", SHIFT_BOOKED: "Booked", SHIFT_CANCELLED: "Cancelled", PAYOUT_PAID: "Paid ✓", PAYMENT_BEING_CHECKED: "Pay", PAY_QUERY_ANSWERED: "Pay question", EARLY_SHIFT_NOTICE: "Early notice", MANAGER_MESSAGE: "Message" };

export function WorkerInbox({ inbox, timezone, locationName, demo }: { inbox: Inbox; timezone: string; locationName: string; demo: boolean }) {
  const notices = inbox.notices.filter(notice => notice.kind !== "MANAGER_MESSAGE");
  return <>
    <section className="panel" aria-labelledby="inbox-title"><h2 id="inbox-title">Updates</h2>
      {notices.length ? <ul className="inbox-list">{notices.map(notice => <li key={notice.id} className={notice.readAt ? undefined : "inbox-new"}>
        <Link href={notice.href.startsWith("/") ? notice.href : "/worker"}><span className="inbox-kind">{KIND[notice.kind] ?? "Update"}</span><strong>{notice.title}</strong><small>{dateTime(notice.createdAt, timezone)}</small></Link>
        <p>{notice.body.split("\n")[0]}</p></li>)}</ul>
        : <p className="note">Offers, bookings, cancellations and payments appear here, and are also emailed to you.</p>}
    </section>
    <section className="panel" id="chat" aria-labelledby="chat-title"><h2 id="chat-title">Messages with {locationName}</h2>
      {inbox.messages.length ? <ol className="chat-thread">{inbox.messages.map(message => <li key={message.id} className={message.fromWorker ? "chat-mine" : "chat-theirs"}>
        <p>{message.body}</p><small>{message.fromWorker ? "You" : message.author ?? "Manager"} · {dateTime(message.createdAt, timezone)}</small></li>)}</ol>
        : <p className="note">No messages yet. Your manager sees what you send here and replies in FairShift; replies are also emailed to you.</p>}
      {demo ? null : <>
        <form action={sendWorkerMessageAction} className="quick-messages" aria-label="Quick messages">{QUICK_MESSAGES.map(text => <button key={text} className="chip-button" name="quick" value={text}>{text}</button>)}</form>
        <form action={sendWorkerMessageAction} className="workspace-form"><label>Message<textarea name="body" maxLength={1000} required rows={2} /></label><button className="primary-button">Send</button></form>
      </>}
    </section>
  </>;
}
