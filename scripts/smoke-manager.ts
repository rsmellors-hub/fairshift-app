import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

import { ManagerForecast } from "../src/app/components/manager-forecast";
import type { Database } from "../src/server/db/client";
import * as schema from "../src/server/db/schema";
import { DEMO_AS_OF, seedDemoHistory } from "../src/server/intelligence/demo";
import { getManagerForecast } from "../src/server/intelligence/manager";

// Reproducible smoke of the real manager component and forecasting service with
// disk-persisted PostgreSQL-compatible data. Not a live PostgreSQL/PayPal claim.
const directory = await mkdtemp(path.join(tmpdir(), "fairshift-manager-smoke-"));
const databasePath = path.join(directory, "database");
const first = new PGlite(databasePath);
try {
  const db = drizzle(first, { schema });
  await migrate(db, { migrationsFolder: "drizzle" });
  assert.equal((await seedDemoHistory(db as unknown as Database)).inserted, 3704);
} finally {
  await first.close();
}

const reopened = new PGlite(databasePath);
try {
  const result = await getManagerForecast(drizzle(reopened, { schema }) as unknown as Database, DEMO_AS_OF);
  assert.equal(result.status, "AVAILABLE");
  if (result.status !== "AVAILABLE") throw new Error("Missing persisted forecast inputs");
  assert.equal(result.source, "DEMO_SEEDED");
  // Demo history ends 14 Oct; from the 15 Oct as-of date the next planning day is Fri 16 Oct.
  assert.equal(result.targetDate, "2026-10-16");
  assert.equal(result.staffing.workers, 8);
  assert.equal(result.staffing.workerDelta, 3);
  const markup = renderToStaticMarkup(createElement(ManagerForecast, { result }));
  assert.ok(markup.includes("Demo / seeded · not PayPal verified"));
  const { readFile } = await import("node:fs/promises");
  const css = await readFile("src/app/styles.css", "utf8");
  const file = path.join(directory, "manager.html");
  await writeFile(file, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>FairShift manager smoke — DEMO</title><style>${css}</style></head><body>${markup}</body></html>`);
  console.log(JSON.stringify({ status: "PASS", persistedTransactions: result.eligibleTransactions, forecastSalesMinor: result.forecastSalesMinor, range: [result.lowerSalesMinor, result.upperSalesMinor], workers: result.staffing.workers, delta: result.staffing.workerDelta, renderedFile: file }));
} finally {
  await reopened.close();
}
