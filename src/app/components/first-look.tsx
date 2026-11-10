import { and, desc, eq, ne } from "drizzle-orm";
import { StatusBadge } from "@/app/components/product-ui";
import { triggeredByLabel } from "@/server/intelligence/customer-types";
import { getDatabase } from "@/server/db/client";
import { localIntelligenceRuns, localIntelligenceSignals } from "@/server/db/schema";

// "First look at your area" (design: Setup step 3). What FairShift's AI search found near the venue after
// its pin was confirmed, each with its source. Nothing changes staffing until someone accepts it.
const when = (date: Date, timezone: string) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: timezone }).format(date);
const day = (date: string) => new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
const KIND: Record<string, string> = { DEMAND: "Demand", CAPACITY: "Can we open?", ACCESS: "Can people get there?" };
const host = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } };

export async function FirstLook({ organisationId, location }: { organisationId: string; location: { id: string; name: string; timezone: string; pinConfirmedAt: Date | null } }) {
  if (!location.pinConfirmedAt) return null;
  const db = getDatabase();
  const [run] = await db.select().from(localIntelligenceRuns).where(and(eq(localIntelligenceRuns.organisationId, organisationId), eq(localIntelligenceRuns.outletId, location.id))).orderBy(desc(localIntelligenceRuns.createdAt)).limit(1);
  const signals = run ? await db.select().from(localIntelligenceSignals).where(and(eq(localIntelligenceSignals.runId, run.id), ne(localIntelligenceSignals.status, "REJECTED"))).limit(6) : [];
  return <section className="panel first-look" aria-labelledby="first-look-title">
    <div className="panel-head"><h2 id="first-look-title"><StatusBadge tone="predictive">AI</StatusBadge> First look at your area</h2>{run ? <small>Started {when(run.createdAt, location.timezone)}</small> : null}</div>
    <p className="panel-lede">Here’s what’s happening near {location.name} this week.</p>
    {!run ? <p className="note">The first look starts when the pin is confirmed. If it hasn’t started, local signals may be unavailable here or today’s AI limit reached; FairShift checks again later.</p>
      : run.status === "RUNNING" ? <p className="note" role="status">Searching local news, events and notices… Reload in a minute.</p>
      : run.status === "FAILED" ? <p className="note">The search didn’t complete ({run.failureCode ?? "unknown"}). Nothing was assumed; you can refresh local signals from Plan later.</p>
      : signals.length ? <ul className="role-list">{signals.map(signal => <li key={signal.id}><p><strong>{KIND[signal.effectType] ?? "Signal"} · {day(signal.validFrom)}{signal.validTo !== signal.validFrom ? ` – ${day(signal.validTo)}` : ""}</strong> {signal.name}</p>
          <p className="note">Source: <a href={signal.sourceUrl} target="_blank" rel="noreferrer">{host(signal.sourceUrl)}</a> · checked by FairShift{triggeredByLabel(signal.triggeredBy) ? ` · ${triggeredByLabel(signal.triggeredBy)}` : ""}</p></li>)}</ul>
      : <p className="note">Nothing relevant found this week. FairShift checks again later.</p>}
    <p className="note">Nothing changes your staffing until you accept it.</p>
  </section>;
}
