import { connectZettleAction, disconnectZettleAction, syncZettleAction } from "@/app/commerce-actions";
import { DataLabel } from "@/app/components/product-ui";
import { money } from "@/app/components/format";
import { longDate } from "@/app/components/staffing";
import type { CommerceConnectionView } from "@/server/commerce/connections";
import { isSyntheticSource, shiftDate, type SalesSource } from "@/server/intelligence/forecast";
import type { DailySalesRow } from "@/server/intelligence/sales-history";
import type { WeeklyForecast } from "@/server/intelligence/weekly";

export const SALES_SOURCE: Record<SalesSource, string> = { ZETTLE: "Zettle sales · connected merchant account", IMPORTED: "Imported sales history · not provider-verified", REFERENCE: "Reference sales history · synthetic", DEMO_SEEDED: "Demo / seeded history", PAYPAL_SANDBOX: "Verified PayPal Sandbox sales" };
const SOURCE_MEANING: Record<SalesSource, string> = {
  ZETTLE: "Retrieved from this location’s connected Zettle account. Completed sales only: refunds are not deducted. Not reconciled by FairShift.",
  IMPORTED: "Supplied for this business. Genuine history, but no provider has verified it.",
  REFERENCE: "Generated for a fictional retailer so the product can be explored. Never a real business’s trading.",
  DEMO_SEEDED: "Generated demonstration records.",
  PAYPAL_SANDBOX: "Completed, verified and reconciled PayPal Sandbox captures. Test money, not trading.",
};
const SOURCE_ORDER: SalesSource[] = ["ZETTLE", "IMPORTED", "REFERENCE", "PAYPAL_SANDBOX", "DEMO_SEEDED"];
const REJECTED: Record<string, string> = { CURRENCY_MISMATCH: "a different currency from this location’s planning", STALE: "not recent enough", INSUFFICIENT_DAYS: "too few trading days", INCOMPLETE_WEEKDAYS: "some weekdays too sparse", AMBIGUOUS: "more than one currency" };
const SYNC_FAILURE: Record<string, string> = {
  AUTH_REJECTED: "Zettle no longer accepts this key. Reconnect with a new one.", SCOPE_MISSING: "This key cannot read purchases. Create one with the purchase permission.",
  RATE_LIMITED: "Zettle asked FairShift to slow down. Try again shortly.", PROVIDER_UNAVAILABLE: "Zettle could not be reached.", MALFORMED_RESPONSE: "Zettle’s response could not be read, so nothing was stored.",
  HISTORY_TOO_LARGE: "More sales were due than one sync can retrieve.", UNSUPPORTED_CURRENCY: "This account trades in a currency FairShift does not support yet.", CURRENCY_MISMATCH: "This account’s currency differs from the Zettle sales already held for this location.",
  CONFLICTING_DUPLICATE: "Zettle returned different details for a sale already held, so nothing was changed.", FUTURE_DATED: "A sale was dated in the future, so nothing was stored.", ABANDONED: "An earlier sync did not finish.",
};
const when = (date: Date, timeZone: string) => new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone }).format(date);
const API_KEY_URL = "https://my.zettle.com/apps/api-keys?name=FairShift&scopes=READ:PURCHASE";

type Location = { id: string; name: string; timezone: string; active: boolean };

function ConnectionState({ connection, timezone }: { connection?: CommerceConnectionView; timezone: string }) {
  if (!connection) return <p>Not connected. This location has no Zettle sales.</p>;
  const run = connection.latestRun, ok = connection.lastSuccess;
  return <>
    <p><strong>{connection.status === "AUTH_FAILED" ? "Connection needs attention" : run?.status === "FAILED" ? "Connected · last sync failed" : ok ? "Connected" : "Connected · not synced yet"}</strong></p>
    {run?.status === "FAILED" ? <p role="alert">{SYNC_FAILURE[run.failureCode ?? ""] ?? "The sync did not complete."} Existing sales history is unchanged. This does not mean no sales happened.</p> : null}
    {ok ? <p>Last completed sync {when(ok.startedAt, timezone)}: {ok.retrieved} retrieved · {ok.inserted} new · {ok.duplicates} already held · {ok.refundsExcluded} refunds excluded.{ok.retrieved === 0 ? " Zettle returned no purchases for this period; that is not confirmed zero trading." : ""}</p> : <p>No sales have been retrieved through this connection yet.</p>}
  </>;
}

// Where this business's commerce comes from, per location, and which history drives its
// forecast. Sources are listed side by side and never added together.
export function OwnerSales({ locations, history, historyUnavailable, weekly, connections, connectionsAvailable, configured }: {
  locations: readonly Location[]; history: readonly DailySalesRow[]; historyUnavailable: boolean; weekly: WeeklyForecast | null;
  connections: readonly CommerceConnectionView[]; connectionsAvailable: boolean; configured: boolean;
}) {
  const active = locations.filter(location => location.active);
  return <>
    <section className="panel" aria-labelledby="commerce-sources-title">
      <h2 id="commerce-sources-title">Connected commerce</h2>
      <p>Connect a location’s Zettle account and its completed sales enter the same history that drives forecast and staffing. Enough recent sales replace other history automatically; until then they are shown but not used.</p>
      {!configured ? <p className="method-note" role="status">Zettle connections are not configured in this environment, so none can be added or synced. Nothing here has been retrieved from Zettle.</p> : null}
      {!connectionsAvailable ? <p role="alert">Connection status could not be loaded. No connection state has been assumed.</p> : active.map(location => {
        const connection = connections.find(row => row.outletId === location.id);
        return <article className="requirement" key={location.id}><h3>{location.name}</h3>
          <ConnectionState connection={connection} timezone={location.timezone} />
          {connection ? <div className="inline-form">
            <form action={syncZettleAction}><input type="hidden" name="outletId" value={location.id} /><button className="primary-button" disabled={!configured || connection.status === "AUTH_FAILED"}>Sync sales from Zettle</button></form>
            <form action={disconnectZettleAction}><input type="hidden" name="outletId" value={location.id} /><button className="secondary-button">Disconnect</button></form>
          </div> : configured ? <details><summary>Connect Zettle for {location.name}</summary>
            <p>In your Zettle account, <a href={API_KEY_URL} rel="noreferrer" target="_blank">create an API key</a> that can read purchases, and copy its client ID and key. One Zettle account feeds one location. FairShift stores the key encrypted and reads only each sale’s identity, time, currency and amount.</p>
            <form action={connectZettleAction} className="workspace-form" autoComplete="off"><input type="hidden" name="outletId" value={location.id} /><label>Client ID<input name="clientId" required maxLength={200} autoComplete="off" /></label><label>API key<input name="apiKey" type="password" required maxLength={8000} autoComplete="off" /></label><button className="primary-button">Connect and check</button></form>
          </details> : null}
        </article>;
      })}
    </section>
    <section className="panel" aria-labelledby="sales-history-title">
      <h2 id="sales-history-title">Sales history by source</h2>
      <p className="method-note">Eligible sales history, grouped by location, source and currency. Imported, reference, demo, Zettle and verified Sandbox sales are reported separately and never combined.</p>
      {historyUnavailable ? <p role="alert">Sales history could not be loaded. No sales have been assumed. Reload to try again.</p> : !history.length ? <p>No commercial history available. No revenue has been assumed.</p> : null}
      {locations.flatMap(location => SOURCE_ORDER.flatMap(source => [...new Set(history.filter(day => day.outletId === location.id && day.source === source).map(day => day.currency))].map(currency => {
        const days = history.filter(day => day.outletId === location.id && day.source === source && day.currency === currency).sort((a, b) => a.date.localeCompare(b.date));
        const forecast = weekly?.outlets.find(row => row.outletId === location.id);
        const today = forecast?.today ?? null, latest = days.at(-1)!.date;
        const used = forecast?.selection.status === "SELECTED" && forecast.selection.source === source && forecast.selection.currency === currency;
        const rejection = forecast?.selection.rejected.find(row => row.source === source && row.currency === currency);
        const ageDays = today ? Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${latest}T12:00:00Z`)) / 86_400_000) : null;
        const lastFortnight = days.filter(day => day.date >= shiftDate(latest, -13)).reverse();
        return <article className="requirement" key={`${location.id}-${source}-${currency}`}>
          <DataLabel kind={isSyntheticSource(source) ? "demo" : "fact"}>{SALES_SOURCE[source]}</DataLabel>
          <h3>{location.name}</h3>
          <p>{money(days.reduce((sum, day) => sum + day.salesMinor, 0), currency)} · {days.reduce((sum, day) => sum + day.transactions, 0)} eligible records · {days.length} trading days, {days[0].date} to {latest}</p>
          <p className="method-note">{SOURCE_MEANING[source]} Latest sale day {longDate(latest)}{ageDays !== null ? `, ${ageDays} ${ageDays === 1 ? "day" : "days"} ago` : ""}.</p>
          <p><strong>{used ? "Drives this location’s forecast" : rejection ? "Not used for forecast" : "Not used for forecast: another source takes precedence"}</strong>{rejection ? ` · ${REJECTED[rejection.reason]}. ${rejection.detail}` : ""}</p>
          <details><summary>Latest days</summary><div className="table-scroll" role="region" aria-label={`${location.name} latest sales days`} tabIndex={0}><table><thead><tr><th>Date</th><th>Sales</th><th>Transactions</th><th>Average</th></tr></thead><tbody>{lastFortnight.map(day => <tr key={day.date}><td>{longDate(day.date)}</td><td>{money(day.salesMinor, currency)}</td><td>{day.transactions}</td><td>{money(Math.round(day.salesMinor / day.transactions), currency)}</td></tr>)}</tbody></table></div><p className="method-note">Days not listed have no records: they are unknown, not zero.</p></details>
        </article>;
      })))}
    </section>
  </>;
}
