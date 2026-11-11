import { parseArgs } from "node:util";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { getDatabaseConfig } from "../src/server/config/env";
import type { Database } from "../src/server/db/client";
import * as schema from "../src/server/db/schema";
import { connectBusinessPayPal } from "../src/server/payments/business-paypal";

// Connects a business's own PayPal Sandbox app on the Owner's behalf, through the same path as
// Business settings › Payouts: a real Sandbox token test first, the secret sealed under
// FAIRSHIFT_CREDENTIALS_KEY, audited without the secret. The credentials are read from the environment
// variables <PREFIX>_PAYPAL_CLIENT_ID and <PREFIX>_PAYPAL_CLIENT_SECRET, never from the command line.
// Prints only the app ID, the sender and the secret's last four characters. Safe to run again (replaces).
const { values } = parseArgs({ options: { organisation: { type: "string" }, "env-prefix": { type: "string" }, sender: { type: "string" } } });
if (!values.organisation || !values["env-prefix"] || !values.sender) {
  console.error("Usage: connect-business-paypal --organisation <id> --env-prefix <PREFIX> --sender <sandbox business email>");
  process.exit(1);
}
const prefix = values["env-prefix"].toUpperCase();
const clientId = process.env[`${prefix}_PAYPAL_CLIENT_ID`], secret = process.env[`${prefix}_PAYPAL_CLIENT_SECRET`];
if (!clientId || !secret) { console.error(`Refused: ${prefix}_PAYPAL_CLIENT_ID and ${prefix}_PAYPAL_CLIENT_SECRET must be set.`); process.exit(1); }

const pool = new Pool({ connectionString: getDatabaseConfig().DATABASE_URL, application_name: "fairshift-connect-paypal" });
try {
  const db = drizzle(pool, { schema }) as unknown as Database;
  const [owner] = await db.select({ userId: schema.memberships.userId }).from(schema.memberships)
    .where(and(eq(schema.memberships.organisationId, values.organisation), eq(schema.memberships.role, "OWNER"), eq(schema.memberships.state, "ACTIVE")))
    .orderBy(asc(schema.memberships.createdAt)).limit(1);
  if (!owner) throw new Error("No active Owner for that business.");
  const result = await connectBusinessPayPal(db, { organisationId: values.organisation, userId: owner.userId, role: "OWNER" }, { clientId, secret, senderEmail: values.sender });
  console.log(JSON.stringify({ organisationId: values.organisation, appId: result.appId, senderEmail: result.senderEmail, secretLast4: result.secretLast4 }));
} catch (error) {
  console.error(`Refused: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
