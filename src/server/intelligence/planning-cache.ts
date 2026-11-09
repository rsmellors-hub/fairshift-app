import type { DatabaseSession } from "@/server/db/client";

// The demo business's computed planning week, kept between requests (Day 6, Step 2). Hosted runs on a very
// small database, and the week is ~35 queries and months of history, so each page would otherwise take
// seconds. A cached week is reused while FairShift has changed nothing it reads: every server action, and
// every scheduler job that writes planning data, bumps a generation, so a change shows on the next page.
// Writes from outside FairShift (a script) show after the five-minute background refresh. (Postgres's row
// counters were tried as a second signal; they update seconds after a write and caused a second full
// recalculation after every action.)
// After five minutes an unchanged week is served while it is recalculated in the background; after an hour
// it is recalculated before it is served. The scheduler warms it on server start. Only the demo business
// is cached (the caller decides).

const STALE_MS = 5 * 60_000, MAX_AGE_MS = 60 * 60_000;
let generation = 0;
export function planningChanged() { generation++; }

export function planningCacheEnabled(env: Record<string, string | undefined> = process.env) {
  return env.FAIRSHIFT_PLANNING_CACHE === "on" || (env.FAIRSHIFT_PLANNING_CACHE !== "off" && env.NODE_ENV === "production");
}

type Entry<T> = { version: string; at: number; value: Promise<T>; refreshing: boolean };
const stores = new WeakMap<object, Map<string, Entry<unknown>>>();

export async function cachedPlanning<T>(db: DatabaseSession, key: string, compute: () => Promise<T>, now = Date.now()): Promise<T> {
  const version = String(generation);
  let store = stores.get(db as object);
  if (!store) { store = new Map(); stores.set(db as object, store); }
  const hit = store.get(key) as Entry<T> | undefined;
  const fresh = () => {
    const value = compute();
    const entry: Entry<T> = { version, at: now, value, refreshing: false };
    store.set(key, entry);
    value.catch(() => { if (store.get(key) === entry) store.delete(key); });
    return value;
  };
  if (!hit || hit.version !== version || now - hit.at >= MAX_AGE_MS) return fresh();
  if (now - hit.at >= STALE_MS && !hit.refreshing) {
    hit.refreshing = true;
    // The cached week is served now; the recalculated one replaces it when ready.
    const next = compute();
    next.then(() => { store.set(key, { version, at: Date.now(), value: next, refreshing: false }); }, () => { hit.refreshing = false; });
  }
  return hit.value;
}
