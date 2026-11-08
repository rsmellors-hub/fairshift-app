import { DataLabel } from "@/app/components/product-ui";

// One way of saying where a signal came from, everywhere it is shown: "Feed: <source>", "AI-found,
// source: <link>", "Owner-entered, source: <link>", with when it was last updated and, for a feed that
// has fallen behind, that it is stale.

export const OPEN_METEO_SITE = "https://open-meteo.com/";
export const stamp = (date: Date, timeZone: string) => new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone }).format(date);
const hostOf = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } };

// Open-Meteo's licence (CC BY 4.0) asks for this link wherever its data are shown.
export function OpenMeteoAttribution() {
  return <a className="text-link source-attribution" href={OPEN_METEO_SITE} target="_blank" rel="noopener noreferrer">Weather data by Open-Meteo.com</a>;
}

export function SourceLink({ url, title }: { url: string; title?: string | null }) {
  return <a className="text-link source-link" href={url} target="_blank" rel="noopener noreferrer nofollow">{title?.trim() ? `${title.trim()} (${hostOf(url)})` : hostOf(url)}</a>;
}

export function FeedLabel({ source, updatedAt, stale, timeZone, fallback = false }: { source: string; updatedAt: Date | null; stale: boolean; timeZone: string; fallback?: boolean }) {
  return <span className="source-line"><DataLabel kind={fallback ? "demo" : "fact"}>{fallback ? `Fallback: ${source}` : `Feed: ${source}`}</DataLabel>{" "}
    <small className={stale ? "source-stale" : undefined}>{stale ? "Stale · " : ""}{updatedAt ? `updated ${stamp(updatedAt, timeZone)}` : "not fetched yet"}</small></span>;
}

export function AiFoundLabel({ url, title }: { url: string; title?: string | null }) {
  return <span className="source-line"><DataLabel kind="predictive">AI-found</DataLabel>, source: <SourceLink url={url} title={title} /></span>;
}

export function OwnerEnteredLabel({ url }: { url: string }) {
  return <span className="source-line"><DataLabel kind="demo">Owner-entered</DataLabel>, source: <SourceLink url={url} /></span>;
}
