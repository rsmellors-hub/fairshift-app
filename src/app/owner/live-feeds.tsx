import Link from "next/link";
import { StatusBadge } from "@/app/components/product-ui";
import { FeedLabel, OpenMeteoAttribution, stamp } from "@/app/components/source-labels";
import { CoverageLog, runLine, SignalCard } from "@/app/manager/local-intelligence";
import type { LiveFeedStatus } from "@/server/intelligence/live-feeds";
import type { WeeklyStaffing } from "@/server/intelligence/staffing";

// Where the context behind the week comes from, for the Owner: every real feed with its source, when it
// last updated and whether it has fallen behind, and what AI found at each location, with its sources
// and what it searched. Read-only.

const state = (status: string) => status === "FRESH" ? <StatusBadge tone="success">Current</StatusBadge> : status === "STALE" ? <StatusBadge tone="warning">Stale</StatusBadge> : <StatusBadge tone="neutral">Not fetched yet</StatusBadge>;

export function OwnerLiveFeeds({ staffing, feeds, timeZone, eventsConfigured, now }: { staffing: WeeklyStaffing | null; feeds: LiveFeedStatus | null; timeZone: string; eventsConfigured: boolean; now: Date }) {
  const outlets = staffing?.outlets ?? [];
  return <section className="panel live-feeds" id="live-feeds" aria-labelledby="live-feeds-title">
    <h2 id="live-feeds-title">Live feeds and AI-found signals</h2>
    <p className="panel-lede">Where the context behind this week comes from and when each source last updated. A feed that has fallen behind is marked stale and its last good data is kept. None of this edits sales history.</p>
    <div className="table-scroll" role="region" aria-label="Live feeds" tabIndex={0}><table className="data-table">
      <caption className="visually-hidden">Live feeds, what they supply and when they last updated</caption>
      <thead><tr><th scope="col">Source</th><th scope="col">Supplies</th><th scope="col">State</th></tr></thead>
      <tbody>
        <tr><th scope="row">{feeds ? <FeedLabel source="Nager.Date public holidays API" updatedAt={feeds.holidays.updatedAt} stale={feeds.holidays.status === "STALE"} timeZone={timeZone} /> : "Public holidays"}</th>
          <td data-label="Supplies">South African public holidays for the planning dates{feeds?.holidays.years.length ? ` (${feeds.holidays.years.join(", ")})` : ""}. Dates it doesn’t cover use FairShift’s built-in rules, labelled as the fallback.</td>
          <td data-label="State">{feeds ? state(feeds.holidays.status) : "Unavailable"}</td></tr>
        <tr><th scope="row">{feeds ? <FeedLabel source="European Central Bank reference rates" updatedAt={feeds.ecb.updatedAt} stale={feeds.ecb.status === "STALE" || !feeds.ecb.fresh} timeZone={timeZone} /> : "ECB reference rate"}</th>
          <td data-label="Supplies">{feeds?.ecb.rate ? `The ZAR to USD payout rate: ${(feeds.ecb.rate.usdZarMicros / 1_000_000).toFixed(4)} ZAR per USD, from the ECB’s rates published for ${feeds.ecb.rate.rateDate}${feeds.ecb.rate.source === "OWNER_MANUAL" ? ", entered by the Owner" : ""}.` : "No reference rate recorded yet."}{feeds && !feeds.ecb.fresh ? " Older than three business days, so payouts are blocked until a newer rate is recorded." : ""}</td>
          <td data-label="State">{feeds ? state(feeds.ecb.fresh && feeds.ecb.status !== "STALE" ? "FRESH" : feeds.ecb.rate ? "STALE" : "NOT_FETCHED") : "Unavailable"}</td></tr>
        {outlets.map(outlet => { const weather = outlet.demandContext?.weather; return weather ? <tr key={`w-${outlet.outletId}`}><th scope="row"><FeedLabel source={`Open-Meteo forecast · ${outlet.outletName}`} updatedAt={weather.fetchedAt} stale={weather.status === "STALE"} timeZone={outlet.timezone} /></th>
          <td data-label="Supplies">Hourly rain chance, rain and temperature for trading hours. A forecast, not a measurement. <OpenMeteoAttribution /></td>
          <td data-label="State">{weather.status === "NO_COORDINATES" ? "No coordinates" : state(weather.status)}</td></tr> : null; })}
        {eventsConfigured ? outlets.map(outlet => { const events = outlet.demandContext?.events; return events ? <tr key={`e-${outlet.outletId}`}><th scope="row"><FeedLabel source={`Ticketmaster listings · ${outlet.outletName}`} updatedAt={events.fetchedAt} stale={events.status === "STALE"} timeZone={outlet.timezone} /></th>
          <td data-label="Supplies">Listed events within 3 km. Listings aren’t complete.</td><td data-label="State">{events.status === "NO_COORDINATES" ? "No coordinates" : state(events.status)}</td></tr> : null; }) : null}
        {outlets.map(outlet => { const run = outlet.localIntelligence?.lastAttempt ?? null; return <tr key={`a-${outlet.outletId}`}><th scope="row">AI local discovery · {outlet.outletName}</th>
          <td data-label="Supplies">{runLine(run, outlet.timezone)}</td>
          <td data-label="State">{!run ? state("NOT_FETCHED") : run.status === "COMPLETED" && now.getTime() - (run.completedAt ?? run.createdAt).getTime() < 36 * 3_600_000 ? state("FRESH") : run.status === "RUNNING" ? <StatusBadge tone="neutral">Running</StatusBadge> : state("STALE")}</td></tr>; })}
      </tbody></table></div>
    {outlets.map(outlet => { const local = outlet.localIntelligence; if (!local || local.status === "UNAVAILABLE") return null; const applied = local.signals.filter(signal => signal.use === "APPLIED").length;
      return <details className="owner-forecast-detail" key={outlet.outletId}><summary><strong>{outlet.outletName}</strong> <small>{local.signals.length} AI-found {local.signals.length === 1 ? "signal" : "signals"} · {applied} applied to the forecast{local.lastAttempt ? ` · last searched ${stamp(local.lastAttempt.createdAt, outlet.timezone)}` : ""}</small></summary>
        {local.signals.length ? <ul className="context-signals">{local.signals.slice(0, 8).map(signal => <SignalCard key={signal.key} signal={signal} />)}</ul> : <p className="note">No AI-found influence with a source for the coming days. That means none was found, not that nothing is happening.</p>}
        {local.signals.length > 8 ? <p className="note">{local.signals.length - 8} more on the location’s Forecast &amp; staffing page.</p> : null}
        {local.runs.map(run => <CoverageLog key={run.id} run={run} timeZone={outlet.timezone} />)}
        <p className="note"><Link className="text-link" href={`/owner/locations/${outlet.outletId}`}>Open {outlet.outletName}</Link></p>
      </details>; })}
  </section>;
}
