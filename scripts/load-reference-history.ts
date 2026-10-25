import { parseArgs } from "node:util";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { getDatabaseConfig } from "../src/server/config/env";
import * as schema from "../src/server/db/schema";
import { provisionReferenceHistory } from "../src/server/reference/provision";
import { REFERENCE_DATASET, REFERENCE_STORE_CODES, REFERENCE_STORES } from "../src/server/reference/uk-retail";

const usage = `Load labelled synthetic REFERENCE sales history into one organisation.

  pnpm reference:load --organisation <uuid> \\
    --outlet UK01=<outlet uuid> --outlet UK02=<outlet uuid> --outlet UK03=<outlet uuid> \\
    --outlet UK04=<outlet uuid> --outlet UK05=<outlet uuid> \\
    [--from YYYY-MM-DD] [--through YYYY-MM-DD] [--set-london-timezone]

Stores: ${REFERENCE_STORES.map(store => `${store.code} ${store.city}`).join(", ")}.
Range: ${REFERENCE_DATASET.firstDate} to ${REFERENCE_DATASET.lastDate} (${REFERENCE_DATASET.currency}).
This is fictional reference data, never provider (Zettle/PayPal) sales.`;

const { values } = parseArgs({ options: {
  organisation: { type: "string" }, outlet: { type: "string", multiple: true },
  from: { type: "string" }, through: { type: "string" }, "set-london-timezone": { type: "boolean" }, help: { type: "boolean" },
} });
const mapping = Object.fromEntries((values.outlet ?? []).map(pair => pair.split("=", 2)));
if (values.help || !values.organisation || REFERENCE_STORE_CODES.some(code => !mapping[code]) || Object.keys(mapping).length !== REFERENCE_STORE_CODES.length) {
  console.error(usage);
  process.exit(values.help ? 0 : 1);
}

const pool = new Pool({ connectionString: getDatabaseConfig().DATABASE_URL, application_name: "fairshift-reference-history" });
try {
  const result = await provisionReferenceHistory(drizzle(pool, { schema }), {
    organisationId: values.organisation, outlets: mapping, from: values.from, through: values.through,
    setLondonTimezone: values["set-london-timezone"] ?? false,
  });
  console.log(`REFERENCE (${result.dataset}, ${result.currency}): ${result.inserted} of ${result.expected} synthetic transactions inserted; existing rows were kept.`);
  for (const store of result.stores) console.log(`  ${store.code} → outlet ${store.outletId}: ${store.transactions ?? 0} reference transactions, data through ${store.dataThrough ?? "none"}`);
} catch (error) {
  // Validation refusals happen before any write; the load itself is one transaction.
  console.error(`Refused, nothing written: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
