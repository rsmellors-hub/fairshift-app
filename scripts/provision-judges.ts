import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { getDatabaseConfig } from "../src/server/config/env";
import type { Database } from "../src/server/db/client";
import * as schema from "../src/server/db/schema";
import { JUDGE_ACCOUNTS, provisionJudgeAccounts, type JudgeRole } from "../src/server/demo/judges";

// Judges' signed-in accounts for the demo business (src/server/demo/judges.ts). Run after demo setup.
// New random passwords are generated for accounts created now (or for all, with --reset-passwords) and
// written only to --out, a file that must be git-ignored; nothing secret is printed. Safe to run again.
const { values } = parseArgs({ options: { out: { type: "string" }, "reset-passwords": { type: "boolean" } } });
if (!values.out) { console.error("Refused: --out <git-ignored credentials file> is required."); process.exit(1); }
const passwords = Object.fromEntries((Object.keys(JUDGE_ACCOUNTS) as JudgeRole[]).map(role => [role, randomBytes(18).toString("base64url")])) as Record<JudgeRole, string>;
const pool = new Pool({ connectionString: getDatabaseConfig().DATABASE_URL, application_name: "fairshift-judge-provision" });
try {
  const reset = !!values["reset-passwords"];
  const result = await provisionJudgeAccounts(drizzle(pool, { schema }) as unknown as Database, passwords, { resetPasswords: reset });
  const written = (Object.keys(JUDGE_ACCOUNTS) as JudgeRole[]).filter(role => reset || result.created.includes(role));
  if (written.length) {
    const lines = [`# FairShift judge accounts (PayPal Sandbox). Private: for Devpost's private judging instructions only.`, `# Written ${new Date().toISOString()}. Sign in at /sign-in.`,
      ...written.map(role => `${role}: ${JUDGE_ACCOUNTS[role].email} / ${passwords[role]}`), ""];
    writeFileSync(values.out, lines.join("\n"), { flag: existsSync(values.out) && !reset && written.length < 3 ? "a" : "w", mode: 0o600 });
    chmodSync(values.out, 0o600);
  }
  console.log(JSON.stringify({ created: result.created, credentialsWrittenFor: written, memberships: result.memberships, accounts: Object.fromEntries(Object.entries(JUDGE_ACCOUNTS).map(([role, account]) => [role, account.email])) }, null, 2));
} catch (error) {
  console.error(`Refused: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
