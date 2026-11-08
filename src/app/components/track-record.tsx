import { DataLabel } from "@/app/components/product-ui";
import type { TrackRecordRow } from "@/server/intelligence/local-intelligence-service";

// The AI signal track record, always labelled with what it was measured against: synthetic reference
// history, which holds no real-world events, so a match or a miss says nothing about the AI's accuracy.
const DATE = (date: string) => new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));

export function TrackRecord({ rows, limit = 10 }: { rows: readonly TrackRecordRow[]; limit?: number }) {
  const matched = rows.filter(row => row.matched).length;
  return <div className="track-record">
    <p><DataLabel kind="demo">Measured against synthetic history</DataLabel> {rows.length ? `${matched} of ${rows.length} applied ${rows.length === 1 ? "direction" : "directions"} matched what happened.` : "No completed day to measure yet."}</p>
    <p className="note">After each day, every applied signal’s direction is compared with that day’s sales in the hours it covered, against the forecast from history up to the day before. The sales here are synthetic reference history, which contains no real-world events, so this shows the method working, not the AI’s accuracy.</p>
    {rows.length ? <ul>{rows.slice(0, limit).map(row => <li key={row.id}>{DATE(row.targetDate)} · {row.name} · predicted {row.predictedDirection === "UP" ? "more" : "fewer"} customers · forecast {Math.round(row.baselineMilliTransactions / 1000)}, actual {Math.round(row.actualMilliTransactions / 1000)} transactions ({row.actualDirection === "FLAT" ? "about level" : row.actualDirection === "UP" ? "more" : "fewer"}) · {row.matched ? "matched" : "not matched"}</li>)}</ul> : null}
  </div>;
}
