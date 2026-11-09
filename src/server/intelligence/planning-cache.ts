import { sql, type SQL } from "drizzle-orm";
import type { DatabaseSession } from "@/server/db/client";

// The demo business's computed planning week, kept between requests (Day 6, Step 2). Hosted runs on a very
// small database, and the week is ~35 queries and months of history, so each page would otherwise take
// seconds. A cached week is reused while nothing it reads has changed:
//  - every server action and scheduler job in this process bumps a generation (writes made here show at
//    once, for the person who made them), and
//  - Postgres's own counters of inserted, updated and deleted rows on the planning tables catch writes from
//    anywhere else (another process or a script), within about a second.
// After a minute an unchanged week is served while it is recalculated in the background; after five
// minutes it is recalculated before it is served. Only the demo business is cached (the caller decides).

const STALE_MS = 60_000, MAX_AGE_MS = 5 * 60_000;
const PLANNING_TABLES = ["sale_transactions", "outlets", "shifts", "shift_offers", "work_allocations", "work_policies", "workload_policies", "outlet_trading_hours", "regular_coverage_windows",
  "demand_context_signals", "demand_context_feeds", "demand_context_proposals", "demand_context_decisions", "external_feeds", "local_intelligence_runs", "local_intelligence_signals",
  "local_intelligence_decisions", "local_intelligence_signal_decisions", "local_intelligence_outcomes", "location_shift_rules", "offer_rounds"] as const;

let generation = 0;
export function planningChanged() { generation++; }

export function planningCacheEnabled(env: Record<string, string | undefined> = process.env) {
  return env.FAIRSHIFT_PLANNING_CACHE === "on" || (env.FAIRSHIFT_PLANNING_CACHE !== "off" && env.NODE_ENV === "production");
}

type Entry<T> = { version: string; at: number; value: Promise<T>; refreshing: boolean };
const stores = new WeakMap<object, Map<string, Entry<unknown>>>();

async function tableVersion(db: DatabaseSession) {
  const tables = sql.join(PLANNING_TABLES.map(name => sql`${name}`), sql`, `);
  const runner = db as unknown as { execute: (query: SQL) => Promise<{ rows: { version: string }[] }> };
  const [row] = (await runner.execute(sql`select coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del), 0)::text as version from pg_stat_user_tables where relname in (${tables})`)).rows;
  return row?.version ?? "0";
}

export async function cachedPlanning<T>(db: DatabaseSession, key: string, compute: () => Promise<T>, now = Date.now()): Promise<T> {
  let version: string;
  try { version = `${generation}:${await tableVersion(db)}`; } catch { return compute(); }
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
