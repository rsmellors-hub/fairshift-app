import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { resolveScope } from "../src/server/auth/access";
import { getDatabaseConfig } from "../src/server/config/env";
import type { Database } from "../src/server/db/client";
import * as schema from "../src/server/db/schema";
import { memberships, shifts, users, workers } from "../src/server/db/schema";
import { SA_REFERENCE_ORGANISATION, saReferenceLocation } from "../src/server/reference/sa-reference";
import { allocateAssignment, confirmWork, createDepartment, createRequirement, createWorkPolicy, offerAssignment, respondToAssignment } from "../src/server/scheduling/operations";
import { addPermanentStaff, saveBlockRoster, saveShiftBlocks, saveTipSettings } from "../src/server/tips/service";
import { localDateTimeToInstant } from "../src/server/domain/timezone";

// LOCAL DEMO FIXTURES ONLY (FS-HACK-SA-SUBMISSION-001 Day 4 demo values). Run after
// seed-sa-runtime.ts. Jacaranda Table Demo: Sandton is SHIFT_POOL (Morning 07:00–12:00, Afternoon
// 12:00–17:00, Evening 17:00–23:00), every other location DIRECT; auto-release cap R1,500 per
// staff member per day. Synthetic permanent staff (front and back of house), a standing Friday block
// roster, and one casual confirmed shift inside two pooled blocks. POS staff references are
// immutable and generated per record, so the synthetic CSV templates in scripts/demo use
// placeholders that this script fills with each person's own reference, writing ready-to-import
// files to --out. Refuses any database that isn't on this machine.
const url = new URL(getDatabaseConfig().DATABASE_URL);
if (!["127.0.0.1", "localhost"].includes(url.hostname) || process.env.NODE_ENV === "production") throw new Error("Local demo fixtures run only against a database on this machine.");
const pool = new Pool({ connectionString: url.toString(), application_name: "fairshift-sa-tips-seed" });
const db = drizzle(pool, { schema }) as unknown as Database;
const ORG = SA_REFERENCE_ORGANISATION.id;
const CAP = 150_000; // R1,500.00

async function ownerAt(locationId: string) {
  const [row] = await db.select({ id: memberships.id, userId: memberships.userId }).from(memberships).innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(users.email, "owner@jacaranda-runtime.example.test"), eq(memberships.organisationId, ORG)));
  if (!row) throw new Error("Run seed-sa-runtime.ts first.");
  return resolveScope(db, row.userId, row.id, locationId);
}
const { values: args } = parseArgs({ options: { out: { type: "string" } } });
if (!args.out) throw new Error("Pass --out <directory> for the generated demo CSV files.");
const codes = new Map<string, string>();
async function staff(owner: Awaited<ReturnType<typeof ownerAt>>, placeholder: string, firstName: string, surname: string) {
  const email = `${firstName.toLowerCase()}.${surname.toLowerCase()}@jacaranda-runtime.example.test`;
  const [existing] = await db.select().from(workers).where(and(eq(workers.organisationId, ORG), eq(workers.email, email)));
  const worker = existing ?? await addPermanentStaff(db, owner, { firstName, surname, email, paypalEmail: `${firstName.toLowerCase()}.paypal@jacaranda-runtime.example.test` });
  codes.set(placeholder, worker.attributionCode);
  return worker;
}

try {
  const sandton = await ownerAt(saReferenceLocation("SA02").id);
  const rosebank = await ownerAt(saReferenceLocation("SA01").id);
  for (const code of ["SA01", "SA03", "SA04", "SA05"] as const) await saveTipSettings(db, await ownerAt(saReferenceLocation(code).id), { policy: "DIRECT", autoReleaseCapMinor: CAP });
  await saveTipSettings(db, sandton, { policy: "SHIFT_POOL", autoReleaseCapMinor: CAP });
  const [morning, afternoon, evening] = await saveShiftBlocks(db, sandton, "Morning 07:00-12:00, Afternoon 12:00-17:00, Evening 17:00-23:00");
  const busi = await staff(sandton, "FS-JTD-SDN-01", "Busi", "Front");
  const kagiso = await staff(sandton, "FS-JTD-SDN-02", "Kagiso", "Front");
  const musa = await staff(sandton, "FS-JTD-SDN-03", "Musa", "Kitchen");
  const friday = 5;
  await saveBlockRoster(db, sandton, busi.id, [{ isoWeekday: friday, blockId: morning.id }, { isoWeekday: friday, blockId: evening.id }]);
  await saveBlockRoster(db, sandton, kagiso.id, [{ isoWeekday: friday, blockId: morning.id }, { isoWeekday: friday, blockId: afternoon.id }]);
  await saveBlockRoster(db, sandton, musa.id, [{ isoWeekday: friday, blockId: afternoon.id }, { isoWeekday: friday, blockId: evening.id }]);
  await staff(rosebank, "FS-JTD-RSB-01", "Palesa", "Front");
  await staff(rosebank, "FS-JTD-RSB-02", "Tumi", "Kitchen");
  // The casual workers' own POS references, for the CSV placeholders.
  for (const [email, placeholder] of [["casual.rosebank@jacaranda-runtime.example.test", "FS-JTD-RSB-C1"], ["casual.sandton@jacaranda-runtime.example.test", "FS-JTD-SDN-C1"]] as const) {
    const [row] = await db.select({ code: workers.attributionCode }).from(workers).where(and(eq(workers.organisationId, ORG), eq(workers.email, email)));
    if (row) codes.set(placeholder, row.code);
  }
  // The Sandton casual's confirmed shift on Friday 6 Nov 2026, 11:00–15:00: inside Morning and Afternoon.
  const [casual] = await db.select().from(workers).where(and(eq(workers.organisationId, ORG), eq(workers.email, "casual.sandton@jacaranda-runtime.example.test")));
  const [managerRow] = await db.select({ id: memberships.id, userId: memberships.userId }).from(memberships).innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(users.email, "manager.sandton@jacaranda-runtime.example.test"), eq(memberships.organisationId, ORG)));
  const manager = await resolveScope(db, managerRow.userId, managerRow.id, sandton.locationId);
  const [existing] = await db.select({ id: shifts.id }).from(shifts).where(and(eq(shifts.outletId, sandton.locationId), eq(shifts.roleName, "Pooled floor shift")));
  if (!existing) {
    const [department] = await createDepartment(db, "Pooled floor shift", manager);
    const [policy] = await createWorkPolicy(db, { earningsModel: "HOURLY", rateMinor: 4_500 }, "Casual floor terms", manager);
    const shift = await createRequirement(db, { departmentId: department.id, policyId: policy.id, startsAt: localDateTimeToInstant("2026-11-06T11:00", "Africa/Johannesburg"), endsAt: localDateTimeToInstant("2026-11-06T15:00", "Africa/Johannesburg"), requiredHeadcount: 1 }, manager);
    const offer = await offerAssignment(db, shift.id, casual.id, manager);
    await respondToAssignment(db, casual.id, offer.id, 1, "ACCEPTED", true, manager);
    await allocateAssignment(db, offer.id, manager);
    await confirmWork(db, offer.id, manager);
  }
  mkdirSync(args.out, { recursive: true });
  const written: string[] = [];
  for (const name of ["jacaranda-sandton-tips", "jacaranda-rosebank-tips"]) {
    const template = readFileSync(join(import.meta.dirname, "demo", `${name}.template.csv`), "utf8");
    const file = join(args.out, `${name}.csv`);
    writeFileSync(file, template.replace(/\{\{(FS-JTD-[A-Z]+-[A-Z0-9]+)\}\}/g, (_, key: string) => { const code = codes.get(key); if (!code) throw new Error(`No POS reference for ${key}.`); return code; }));
    written.push(file);
  }
  console.log(JSON.stringify({ csv: written, shiftPool: "Sandton (SA02)", direct: ["Rosebank (SA01)", "Pretoria Central (SA03)", "Durban North (SA04)", "Cape Town Gardens (SA05)"], capRand: CAP / 100,
    blocks: [morning, afternoon, evening].map(block => block.name), permanentStaff: 5, casualConfirmedPooledShift: "2026-11-06 11:00-15:00 Sandton" }, null, 2));
} finally {
  await pool.end();
}
