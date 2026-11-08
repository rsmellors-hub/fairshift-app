import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { SourceOutcome } from "@/server/intelligence/local-intelligence-contract";

// FairShift's own check of a source page the model cited: does it answer, and had the model's web
// search opened it? Only https pages on public hosts are fetched, every redirect hop is checked again,
// nothing is sent with the request but a generic client name, and no body is read or kept. It asks
// with GET, not HEAD: some official sites never answer HEAD, and some take several seconds just to
// open a secure connection, so the wait is generous.

// Why a page couldn't be reached, when FairShift can tell: a certificate it couldn't verify (FairShift
// never skips that check), no answer in time, or the network.
export type SourceFailure = "CERTIFICATE" | "TIMEOUT" | "NETWORK";
export type SourceCheck = { outcome: SourceOutcome; httpStatus: number | null; reason?: SourceFailure };
const failureOf = (error: unknown): SourceFailure => {
  const code = String((error as { cause?: { code?: unknown } } | null)?.cause?.code ?? "");
  return /CERT|SIGNATURE|SELF_SIGNED|ERR_TLS|ISSUER/i.test(code) ? "CERTIFICATE" : error instanceof DOMException && error.name === "TimeoutError" ? "TIMEOUT" : "NETWORK";
};
export type SourceChecker = (url: string) => Promise<SourceCheck>;
type Lookup = (hostname: string) => Promise<string[]>;

const USER_AGENT = "FairShift-source-check/1.0";
const BLOCKED_HOSTS = /^(localhost|.*\.localhost|.*\.local|.*\.internal|metadata\.google\.internal)$/i;

function privateAddress(address: string) {
  const v4 = address.startsWith("::ffff:") ? address.slice(7) : address;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  const v6 = address.toLowerCase();
  return v6 === "::" || v6 === "::1" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80");
}

export function publicHttpsUrl(value: string): URL | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return null;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host.includes(".") || isIP(host) || BLOCKED_HOSTS.test(host)) return null;
  return url;
}

const defaultLookup: Lookup = async hostname => (await dnsLookup(hostname, { all: true })).map(row => row.address);

export function createSourceChecker(options: { fetchImpl?: typeof fetch; lookup?: Lookup; timeoutMs?: number; maxRedirects?: number } = {}): SourceChecker {
  const fetchImpl = options.fetchImpl ?? fetch, lookup = options.lookup ?? defaultLookup;
  const timeoutMs = options.timeoutMs ?? 15_000, maxRedirects = options.maxRedirects ?? 3;
  return async value => {
    let url = publicHttpsUrl(value);
    for (let hop = 0; url && hop <= maxRedirects; hop++) {
      try {
        const addresses = await lookup(url.hostname);
        if (!addresses.length || addresses.some(privateAddress)) return { outcome: "INVALID", httpStatus: null };
      } catch { return { outcome: "UNREACHABLE", httpStatus: null }; }
      let response: Response;
      try {
        response = await fetchImpl(url, { method: "GET", redirect: "manual", headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,*/*" }, signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
        // Only the status matters: the body is never read.
        await response.body?.cancel().catch(() => undefined);
      } catch (error) { return { outcome: "UNREACHABLE", httpStatus: null, reason: failureOf(error) }; }
      const status = response.status;
      if (status >= 300 && status < 400) {
        const location = response.headers.get("location");
        if (!location) return { outcome: "UNREACHABLE", httpStatus: status };
        url = publicHttpsUrl(new URL(location, url).toString());
        continue;
      }
      if (status >= 200 && status < 300) return { outcome: "REACHABLE", httpStatus: status };
      if (status === 401 || status === 403 || status === 429) return { outcome: "RESTRICTED", httpStatus: status };
      if (status >= 400 && status < 500) return { outcome: "NOT_FOUND", httpStatus: status };
      return { outcome: "UNREACHABLE", httpStatus: status };
    }
    return { outcome: url ? "UNREACHABLE" : "INVALID", httpStatus: null };
  };
}

// The same page, however a link to it is written: scheme and host case, a leading www., a fragment,
// tracking parameters and a trailing slash don't make a different page.
export function normaliseUrl(value: string) {
  try {
    const url = new URL(value);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid|gclid|mc_)/i.test(key)) url.searchParams.delete(key);
    return `${url.protocol}//${url.hostname}${url.pathname.replace(/\/+$/, "")}${url.search}`;
  } catch { return value.trim(); }
}

// The site a host belongs to, without a public-suffix list: two labels, or three under a two-part
// country suffix such as gov.za or co.uk.
export function siteOf(hostname: string) {
  const labels = hostname.toLowerCase().replace(/^www\./, "").split(".");
  const twoPart = labels.length >= 3 && labels.at(-1)!.length === 2 && labels.at(-2)!.length <= 3;
  return labels.slice(twoPart ? -3 : -2).join(".");
}

// Whether the model's search opened this page, or at least another page of the same site.
export function consultedBy(value: string, consulted: readonly string[]) {
  const target = normaliseUrl(value);
  const exact = consulted.some(row => normaliseUrl(row) === target);
  let site = false;
  try { const host = siteOf(new URL(value).hostname); site = consulted.some(row => { try { return siteOf(new URL(row).hostname) === host; } catch { return false; } }); } catch { site = false; }
  return { exact, site };
}
