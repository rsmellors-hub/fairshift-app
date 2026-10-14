import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { getDatabaseConfig } from "../src/server/config/env";
import * as schema from "../src/server/db/schema";
import { seedDemoHistory } from "../src/server/intelligence/demo";

const pool = new Pool({ connectionString: getDatabaseConfig().DATABASE_URL, application_name: "fairshift-seed-demo" });
try {
  const result = await seedDemoHistory(drizzle(pool, { schema }));
  console.log(`DEMO/SEEDED: ${result.inserted} synthetic transactions inserted (${result.seedVersion}); no PayPal verification.`);
} finally {
  await pool.end();
}
