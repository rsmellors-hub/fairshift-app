import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { getDatabaseConfig } from "../src/server/config/env";
import type { Database } from "../src/server/db/client";
import * as schema from "../src/server/db/schema";
import { getLiveFeedStatus } from "../src/server/intelligence/live-feeds";
import { demoOrganisationIds, jobStates, runDueJobs } from "../src/server/scheduler/feeds";

// OPERATOR SCRIPT. Runs every due feed job once, exactly as the server's schedule would: weather for
// every demo location, South Africa's holiday feed and the ECB rate. The AI discovery jobs stay off
// here; scripts/local-intelligence.ts runs those deliberately. Prints each job's outcome and state.
const pool = new Pool({ connectionString: getDatabaseConfig().DATABASE_URL, application_name: "fairshift-scheduled-feeds" });
const db = drizzle(pool, { schema }) as unknown as Database;
try {
  const organisations = demoOrganisationIds();
  if (!organisations.length) console.log("No demo organisation is configured, so weather is skipped.");
  for (const row of await runDueJobs(db, { now: () => new Date(), demoOrganisationIds: organisations, aiSchedule: false })) console.log(`${row.key}: ${row.outcome}${row.outcome === "RAN" ? (row.ok ? " ok" : ` failed (${row.code})`) : ""}`);
  for (const state of await jobStates(db)) console.log(`  ${state.job}: last success ${state.lastSuccessAt?.toISOString() ?? "never"}${state.lastFailureCode ? ` · last failure ${state.lastFailureCode}` : ""} · ${JSON.stringify(state.lastResult)}`);
  const feeds = await getLiveFeedStatus(db);
  console.log(`Holidays feed: ${feeds.holidays.status}, updated ${feeds.holidays.updatedAt?.toISOString() ?? "never"}, years ${feeds.holidays.years.join(", ") || "none"}`);
  console.log(`ECB feed: ${feeds.ecb.status}, updated ${feeds.ecb.updatedAt?.toISOString() ?? "never"}, rate ${feeds.ecb.rate ? `${feeds.ecb.rate.rateDate} (${feeds.ecb.fresh ? "fresh" : "older than three business days"})` : "none"}`);
} catch (error) {
  console.error(`Refused: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
