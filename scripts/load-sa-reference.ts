import { parseArgs } from "node:util";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { getDatabaseConfig } from "../src/server/config/env";
import * as schema from "../src/server/db/schema";
import { provisionSaReferenceBusiness } from "../src/server/reference/sa-provision";
import { SA_REFERENCE_DATASET, SA_REFERENCE_LOCATIONS, SA_REFERENCE_ORGANISATION, SA_REFERENCE_WORKLOAD_POLICY } from "../src/server/reference/sa-reference";

const usage = `Make the South African reference business available, with labelled synthetic REFERENCE sales history.

  pnpm reference:sa [--from YYYY-MM-DD] [--through YYYY-MM-DD]

Business: ${SA_REFERENCE_ORGANISATION.name} (${SA_REFERENCE_ORGANISATION.id}), fictional.
Locations: ${SA_REFERENCE_LOCATIONS.map(row => `${row.code} ${row.name}`).join(", ")}.
Range: ${SA_REFERENCE_DATASET.firstDate} to ${SA_REFERENCE_DATASET.lastDate} (${SA_REFERENCE_DATASET.currency}, ${SA_REFERENCE_DATASET.timezone}), never beyond the latest completed day.
Creates the organisation and locations if they are missing and keeps them if they exist. Sets
trading hours, standing regular cover and the reference workload policy
(${SA_REFERENCE_WORKLOAD_POLICY.transactionsPerStaffHour} transactions per operational staff-hour, minimum ${SA_REFERENCE_WORKLOAD_POLICY.minimumStaffWhileOpen} staff while open) unless the business has its own.
Creates no people, accounts, pay terms or subscriptions.
This is fictional reference data, never provider (Square or PayPal) or South African merchant sales.`;

const { values } = parseArgs({ options: { from: { type: "string" }, through: { type: "string" }, help: { type: "boolean" } } });
if (values.help) {
  console.log(usage);
  process.exit(0);
}

const pool = new Pool({ connectionString: getDatabaseConfig().DATABASE_URL, application_name: "fairshift-sa-reference" });
try {
  const result = await provisionSaReferenceBusiness(drizzle(pool, { schema }), { from: values.from, through: values.through });
  console.log(`REFERENCE (${result.dataset}, ${result.currency}): ${result.inserted} of ${result.expected} synthetic transactions inserted; existing rows were kept.`);
  for (const store of result.stores) console.log(`  ${store.code} → location ${store.outletId}: ${store.transactions ?? 0} reference transactions, data through ${store.dataThrough ?? "none"}`);
} catch (error) {
  console.error(`Refused: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
