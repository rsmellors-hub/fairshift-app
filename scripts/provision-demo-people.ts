import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync } from "node:fs";
import { parseArgs } from "node:util";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { getDatabaseConfig } from "../src/server/config/env";
import type { Database } from "../src/server/db/client";
import * as schema from "../src/server/db/schema";
import { DEMO_PEOPLE, provisionDemoPeople, type DemoPerson } from "../src/server/demo/people";

// The demo business's extra fictional workers (src/server/demo/people.ts). Run after demo setup.
// --person THABO|SIPHO (repeatable), --receiver-<person> <PayPal Sandbox personal account>, --out <git-ignored
// credentials file>. A new random password is generated for an account created now and appended to --out
// under --label (e.g. WORKER2); nothing secret is printed. Safe to run again.
const { values } = parseArgs({ options: { person: { type: "string", multiple: true }, "receiver-thabo": { type: "string" }, "receiver-sipho": { type: "string" }, out: { type: "string" }, label: { type: "string", multiple: true } } });
const only = (values.person ?? []).map(value => value.toUpperCase()) as DemoPerson[];
if (!only.length || only.some(key => !(key in DEMO_PEOPLE)) || !values.out) { console.error("Refused: --person THABO|SIPHO and --out <git-ignored credentials file> are required."); process.exit(1); }
const labels = Object.fromEntries(only.map((key, i) => [key, values.label?.[i] ?? key]));
const receivers = { THABO: values["receiver-thabo"], SIPHO: values["receiver-sipho"] };
const passwords = Object.fromEntries(only.map(key => [key, randomBytes(18).toString("base64url")])) as Partial<Record<DemoPerson, string>>;
const pool = new Pool({ connectionString: getDatabaseConfig().DATABASE_URL, application_name: "fairshift-demo-people" });
try {
  const result = await provisionDemoPeople(drizzle(pool, { schema }) as unknown as Database, { passwords, receivers, only });
  if (result.created.length) {
    appendFileSync(values.out, result.created.map(key => `${labels[key]}: ${DEMO_PEOPLE[key].email} / ${passwords[key]}\n`).join(""), { mode: 0o600 });
    chmodSync(values.out, 0o600);
  }
  console.log(JSON.stringify({ created: result.created, credentialsWrittenFor: result.created.map(key => labels[key]), people: result.people }, null, 2));
} catch (error) {
  console.error(`Refused: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
