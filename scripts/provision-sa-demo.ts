import { parseArgs } from "node:util";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { getDatabaseConfig } from "../src/server/config/env";
import type { Database } from "../src/server/db/client";
import * as schema from "../src/server/db/schema";
import { DEMO_ACCOUNTS, provisionSaDemo } from "../src/server/demo/provision";

// Demo setup for the fictional South African demo business (src/server/demo/provision.ts): locations,
// labelled reference history, the three synthetic demo accounts and tomorrow's booked casual shift at
// Rosebank. Safe to run again. FAIRSHIFT_DEMO_ACCOUNT_PASSWORD (optional, 12+ characters) lets the
// demo accounts sign in; it is never printed. The membership IDs it prints are the
// FAIRSHIFT_DEMO_*_MEMBERSHIP_ID settings that turn the public demo on. --from/--through limit the
// reference-history check to a date range, as for pnpm reference:sa (re-runs needn't resend it all).
const { values } = parseArgs({ options: { from: { type: "string" }, through: { type: "string" } } });
const pool = new Pool({ connectionString: getDatabaseConfig().DATABASE_URL, application_name: "fairshift-sa-demo-provision" });
try {
  const result = await provisionSaDemo(drizzle(pool, { schema }) as unknown as Database, { password: process.env.FAIRSHIFT_DEMO_ACCOUNT_PASSWORD, range: { from: values.from, through: values.through } });
  console.log(JSON.stringify({ ...result, accounts: Object.fromEntries(Object.entries(DEMO_ACCOUNTS).map(([persona, account]) => [persona, account.email])) }, null, 2));
  if (!result.entitled) console.log("Not yet entitled: approve the demo business's PayPal Sandbox subscription, then run this again to invite the Manager and the casual worker and book tomorrow's shift.");
} catch (error) {
  console.error(`Refused: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
