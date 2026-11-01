import { connectSquareAction, disconnectSquareAction, syncSquareAction } from "@/app/square-actions";
import { DataLabel } from "@/app/components/product-ui";
import { money } from "@/app/components/format";
import { longDate } from "@/app/components/staffing";
import type { CommerceConnectionView } from "@/server/commerce/connections";
import type { SquareActivity } from "@/server/commerce/square-connection";
import { isSyntheticSource, shiftDate, type SalesSource } from "@/server/intelligence/forecast";
import type { DailySalesRow } from "@/server/intelligence/sales-history";
import { PROVIDER_RULE, type WeeklyForecast } from "@/server/intelligence/weekly";

export const SALES_SOURCE: Record<SalesSource, string> = { SQUARE: "Square Sandbox sales · connected seller", ZETTLE: "Earlier connected-account sales", IMPORTED: "Imported sales history · not provider-verified", REFERENCE: "Reference sales history · synthetic", DEMO_SEEDED: "Demo / seeded history", PAYPAL_SANDBOX: "Verified PayPal Sandbox sales" };
const SOURCE_MEANING: Record<SalesSource, string> = {
  SQUARE: "Retrieved from this location’s connected Square Sandbox seller. Test money, not trading. Completed payments, gross of refunds: refunds are recorded and linked, not netted off. Not reconciled by FairShift.",
  ZETTLE: "Retrieved from a previously connected account. Completed sales only: refunds are not deducted. Not reconciled by FairShift.",
  IMPORTED: "Supplied for this business. Genuine history, but no provider has verified it.",
  REFERENCE: "Generated for a fictional retailer so the product can be explored. Never a real business’s trading.",
  DEMO_SEEDED: "Generated demonstration records.",
  PAYPAL_SANDBOX: "Completed, verified and reconciled PayPal Sandbox captures. Test money, not trading.",
};
const SOURCE_ORDER: SalesSource[] = ["SQUARE", "ZETTLE", "IMPORTED", "REFERENCE", "PAYPAL_SANDBOX", "DEMO_SEEDED"];
const REJECTED: Record<string, string> = { CURRENCY_MISMATCH: "a different currency from this location’s planning", STALE: "not recent enough", INSUFFICIENT_DAYS: "too few trading days", INCOMPLETE_WEEKDAYS: "some weekdays too sparse", AMBIGUOUS: "more than one currency" };
const SYNC_FAILURE: Record<string, string> = {
  AUTH_REJECTED: "Square no longer accepts these Sandbox credentials. Disconnect and connect again.", SCOPE_MISSING: "These credentials cannot read payments.",
  RATE_LIMITED: "Square asked FairShift to slow down. Try again shortly.", PROVIDER_UNAVAILABLE: "Square could not be reached.", MALFORMED_RESPONSE: "Square’s response could not be read, so nothing was stored.",
  HISTORY_TOO_LARGE: "More sales were due than one sync can retrieve.", UNSUPPORTED_CURRENCY: "This seller trades in a currency FairShift does not support yet.", CURRENCY_MISMATCH: "This seller’s currency differs from the Square sales already held for this location.",
  CONFLICTING_DUPLICATE: "Square returned different details for a payment already held, so nothing was changed.", FUTURE_DATED: "A payment was dated in the future, so nothing was stored.", ABANDONED: "An earlier sync did not finish.",
};
const when = (date: Date, timeZone: string) => new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone }).format(date);

type Location = { id: string; name: string; timezone: string; active: boolean };

const ATTRIBUTION: Record<SquareActivity[number]["attribution"]["state"], string> = { ATTRIBUTED: "", NO_TEAM_MEMBER: "Not attributed · no team member on the payment", NOT_MAPPED: "Not attributed · team member not mapped", NOT_IN_SHIFT: "Not attributed · outside an accepted shift" };

function ConnectionState({ connection, timezone }: { connection?: CommerceConnectionView; timezone: string }) {
  if (!connection) return <p>Not connected. This location has no Square Sandbox sales.</p>;
  const run = connection.latestRun, ok = connection.lastSuccess;
  return <>
    <p><strong>{connection.status === "AUTH_FAILED" ? "Connection needs attention" : run?.status === "FAILED" ? "Connected · last sync failed" : ok ? "Connected · Square Sandbox" : "Connected · not synced yet"}</strong></p>
    {run?.status === "FAILED" ? <p role="alert">{SYNC_FAILURE[run.failureCode ?? ""] ?? "The sync did not complete."} Existing sales history is unchanged. This does not mean no sales happened.</p> : null}
    {ok ? <p>Last completed sync {when(ok.startedAt, timezone)}: {ok.retrieved} retrieved · {ok.inserted} new · {ok.duplicates} already held · {ok.refundsExcluded} refunds recorded, not deducted.{ok.retrieved === 0 ? " Square returned no payments for this period; that is not confirmed zero trading." : ""}</p> : <p>No sales have been retrieved through this connection yet.</p>}
  </>;
}

// Latest payments as Square reported them, for audit. Refunds sit beside the sale and aren't netted.
function SquarePayments({ activity, timezone, name }: { activity: SquareActivity; timezone: string; name: string }) {
  if (!activity.length) return null;
  return <details><summary>Latest Square Sandbox payments</summary><div className="table-scroll" role="region" aria-label={`${name} latest Square Sandbox payments`} tabIndex={0}><table><thead><tr><th>Time</th><th>Amount</th><th>Status</th><th>Refunded</th><th>Attribution</th><th>Reference</th></tr></thead><tbody>{activity.map(row => <tr key={row.reference}><td>{when(row.occurredAt, timezone)}</td><td>{money(row.amountMinor, row.currencyCode)}</td><td>{row.status}</td><td>{row.refundedMinor ? money(row.refundedMinor, row.currencyCode) : "None"}</td><td>{row.attribution.state === "ATTRIBUTED" ? `Square team member · ${row.attribution.workerName}` : ATTRIBUTION[row.attribution.state]}</td><td>…{row.reference}</td></tr>)}</tbody></table></div>
    <p className="method-note">Refunds are linked for audit and don’t change a worker’s result. Who is responsible for a refund is not decided by FairShift or by Square’s records.</p></details>;
}

// Where this business's commerce comes from, per location, and which history drives its
// forecast. Sources are listed side by side and never added together.
export function OwnerSales({ locations, history, historyUnavailable, weekly, connections, connectionsAvailable, configured, activity = [] }: {
  locations: readonly Location[]; history: readonly DailySalesRow[]; historyUnavailable: boolean; weekly: WeeklyForecast | null;
  connections: readonly CommerceConnectionView[]; connectionsAvailable: boolean; configured: boolean; activity?: readonly { outletId: string; rows: SquareActivity }[];
}) {
  const active = locations.filter(location => location.active);
  const square = connections.filter(row => row.provider === "SQUARE");
  return <>
    <section className="panel" aria-labelledby="commerce-sources-title">
      <h2 id="commerce-sources-title">Connected commerce</h2>
      <p>Connect one location to the Square Sandbox seller and its completed payments enter the same history that drives forecast and staffing. Enough recent sales replace other history automatically; until then they are shown but not used. One Square location connects to one FairShift location, and other locations keep their existing sources.</p>
      {!configured ? <p className="method-note" role="status">Square Sandbox is not configured in this environment, so no connection can be added or synced. Nothing here has been retrieved from Square.</p> : null}
      {!connectionsAvailable ? <p role="alert">Connection status could not be loaded. No connection state has been assumed.</p> : active.map(location => {
        const connection = square.find(row => row.outletId === location.id);
        return <article className="requirement" key={location.id}><h3>{location.name}</h3>
          <ConnectionState connection={connection} timezone={location.timezone} />
          {connection ? <div className="inline-form">
            <form action={syncSquareAction}><input type="hidden" name="outletId" value={location.id} /><button className="primary-button" disabled={!configured || connection.status === "AUTH_FAILED"}>Sync sales from Square</button></form>
            <form action={disconnectSquareAction}><input type="hidden" name="outletId" value={location.id} /><button className="secondary-button">Disconnect</button></form>
          </div> : configured && !square.length ? <form action={connectSquareAction}><input type="hidden" name="outletId" value={location.id} /><button className="primary-button">Connect Square Sandbox to {location.name}</button></form> : null}
          <SquarePayments activity={activity.find(row => row.outletId === location.id)?.rows ?? []} timezone={location.timezone} name={location.name} />
        </article>;
      })}
    </section>
    <section className="panel" aria-labelledby="sales-history-title">
      <h2 id="sales-history-title">Sales history by source</h2>
      <p className="method-note">Eligible sales history, grouped by location, source and currency. Imported, reference, demo, Square Sandbox and verified PayPal Sandbox sales are reported separately and never combined.</p>
      {historyUnavailable ? <p role="alert">Sales history could not be loaded. No sales have been assumed. Reload to try again.</p> : !history.length ? <p>No commercial history available. No revenue has been assumed.</p> : null}
      {locations.flatMap(location => SOURCE_ORDER.flatMap(source => [...new Set(history.filter(day => day.outletId === location.id && day.source === source).map(day => day.currency))].map(currency => {
        const days = history.filter(day => day.outletId === location.id && day.source === source && day.currency === currency).sort((a, b) => a.date.localeCompare(b.date));
        const forecast = weekly?.outlets.find(row => row.outletId === location.id);
        const today = forecast?.today ?? null, latest = days.at(-1)!.date;
        const used = forecast?.selection.status === "SELECTED" && forecast.selection.source === source && forecast.selection.currency === currency;
        const rejection = forecast?.selection.rejected.find(row => row.source === source && row.currency === currency);
        // A forecast counts completed days only, so a source trading only today has no rejection yet.
        const completedDays = days.filter(day => !today || day.date < today).length;
        const thinProvider = source === "SQUARE" && !used && !rejection && completedDays < PROVIDER_RULE.minimumDays;
        const ageDays = today ? Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${latest}T12:00:00Z`)) / 86_400_000) : null;
        const lastFortnight = days.filter(day => day.date >= shiftDate(latest, -13)).reverse();
        return <article className="requirement" key={`${location.id}-${source}-${currency}`}>
          <DataLabel kind={isSyntheticSource(source) ? "demo" : "fact"}>{SALES_SOURCE[source]}</DataLabel>
          <h3>{location.name}</h3>
          <p>{money(days.reduce((sum, day) => sum + day.salesMinor, 0), currency)} · {days.reduce((sum, day) => sum + day.transactions, 0)} eligible records · {days.length} trading days, {days[0].date} to {latest}</p>
          <p className="method-note">{SOURCE_MEANING[source]} Latest sale day {longDate(latest)}{ageDays !== null ? `, ${ageDays} ${ageDays === 1 ? "day" : "days"} ago` : ""}.</p>
          <p><strong>{used ? "Drives this location’s forecast" : rejection || thinProvider ? "Not used for forecast" : "Not used for forecast: another source takes precedence"}</strong>{rejection ? ` · ${REJECTED[rejection.reason]}. ${rejection.detail}` : thinProvider ? ` · ${REJECTED.INSUFFICIENT_DAYS}. ${completedDays} of ${PROVIDER_RULE.minimumDays} required completed days. Today counts once it has finished.` : ""}</p>
          <details><summary>Latest days</summary><div className="table-scroll" role="region" aria-label={`${location.name} latest sales days`} tabIndex={0}><table><thead><tr><th>Date</th><th>Sales</th><th>Transactions</th><th>Average</th></tr></thead><tbody>{lastFortnight.map(day => <tr key={day.date}><td>{longDate(day.date)}</td><td>{money(day.salesMinor, currency)}</td><td>{day.transactions}</td><td>{money(Math.round(day.salesMinor / day.transactions), currency)}</td></tr>)}</tbody></table></div><p className="method-note">Days not listed have no records: they are unknown, not zero.</p></details>
        </article>;
      })))}
    </section>
  </>;
}
