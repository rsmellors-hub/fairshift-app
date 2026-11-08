import { parseArgs } from "node:util";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { getDatabaseConfig } from "../src/server/config/env";
import type { Database } from "../src/server/db/client";
import * as schema from "../src/server/db/schema";
import { localIntelligenceSignals, outlets } from "../src/server/db/schema";
import { getLocalDiscoveryProvider } from "../src/server/integrations/openai/web-discovery";
import { RUN_KINDS, type RunKind } from "../src/server/intelligence/local-intelligence-contract";
import { runLocalDiscovery } from "../src/server/intelligence/local-intelligence-service";
import { createSourceChecker } from "../src/server/intelligence/local-intelligence-sources";
import { SA_REFERENCE_ORGANISATION } from "../src/server/reference/sa-reference";

// OPERATOR SCRIPT. One genuine local-intelligence discovery per location, once, outside the schedule:
// for verifying the integration. Each call counts against the organisation's daily cap. Nothing runs
// without --confirm. Prints what each run found and where from; never a credential.
const usage = `One local-intelligence discovery per location (a genuine model call with web search).

  node --env-file=<env> --import tsx scripts/local-intelligence.ts --confirm [--organisation <uuid>] [--location <name>]... [--kind DAILY|DISRUPTIONS]

Defaults: the fictional Jacaranda Table Demo organisation, every active location, a DAILY run.`;

const { values } = parseArgs({ options: { organisation: { type: "string" }, location: { type: "string", multiple: true }, kind: { type: "string" }, confirm: { type: "boolean" }, help: { type: "boolean" } } });
if (values.help || !values.confirm) { console.log(usage); process.exit(values.help ? 0 : 1); }
const kind = (values.kind ?? "DAILY") as RunKind;
if (!RUN_KINDS.includes(kind)) { console.error(`Unknown kind ${kind}.`); process.exit(1); }
const provider = getLocalDiscoveryProvider();
if (!provider) { console.error("BLOCKED: no AI provider is configured (OPENAI_API_KEY)."); process.exit(1); }

const organisationId = values.organisation ?? SA_REFERENCE_ORGANISATION.id;
const pool = new Pool({ connectionString: getDatabaseConfig().DATABASE_URL, application_name: "fairshift-local-intelligence" });
const db = drizzle(pool, { schema }) as unknown as Database;
try {
  const locations = (await db.select({ id: outlets.id, name: outlets.name }).from(outlets).where(and(eq(outlets.organisationId, organisationId), eq(outlets.active, true))).orderBy(outlets.name))
    .filter(row => !values.location?.length || values.location.some(name => name.toLowerCase() === row.name.toLowerCase()));
  if (!locations.length) throw new Error("No matching active location.");
  const checkSource = createSourceChecker();
  for (const location of locations) {
    const outcome = await runLocalDiscovery(db, { organisationId, outletId: location.id }, { kind, trigger: "MANUAL", provider, checkSource });
    const run = outcome.run;
    console.log(`\n${location.name}: ${outcome.status}${run ? ` · run ${run.id} · response ${run.providerResponseId ?? "none"} · model ${run.model} (answered by ${run.responseModel ?? "none"})${run.failureCode ? ` · failure ${run.failureCode}` : ""}` : ""}`);
    if (!run) continue;
    const searches = (run.searches as { action: string; queries: string[]; url: string | null }[]);
    console.log(`  window ${run.windowFrom} to ${run.windowTo} · ${searches.length} search actions · ${(run.consultedUrls as string[]).length} pages consulted · counts ${JSON.stringify(run.counts)}`);
    for (const row of run.coverage as { category: string; outcome: string; queries: string[] }[]) console.log(`  coverage ${row.category}: ${row.outcome}${row.queries.length ? ` · ${row.queries.join(" | ")}` : ""}`);
    for (const signal of await db.select().from(localIntelligenceSignals).where(eq(localIntelligenceSignals.runId, run.id)))
      console.log(`  signal [${signal.status}${signal.rejectionCode ? ` ${signal.rejectionCode}` : ""}] ${signal.category}${signal.otherLabel ? ` (${signal.otherLabel})` : ""} · ${signal.effectType} ${signal.direction ?? ""}${signal.sizeBand ? ` ${signal.sizeBand}` : ""}${signal.severity ? ` severity ${signal.severity}` : ""}${signal.closureLikely ? " closure likely" : ""} · ${signal.validFrom}${signal.validTo !== signal.validFrom ? `–${signal.validTo}` : ""} · ${signal.name} · ${signal.sourceTier} · ${signal.sourceUrl} (${signal.sourceCheck}${signal.sourceHttpStatus ? ` ${signal.sourceHttpStatus}` : ""}, search ${signal.consultedInSearch})`);
  }
} catch (error) {
  console.error(`Refused: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
