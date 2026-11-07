import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { getDatabaseConfig } from "../src/server/config/env";
import * as schema from "../src/server/db/schema";
import { ECB_DAILY_URL, fetchEcbDailyQuote, isFreshRateDate, recordEcbQuote } from "../src/server/fx/reference-rates";

// Records the ECB's latest euro reference rates (DEC-SA-012) from its public daily file. Prints the
// reference date and quotes; never invents a value. A failed fetch records nothing, and the Owner
// can enter the ECB's published rate by hand instead.
const pool = new Pool({ connectionString: getDatabaseConfig().DATABASE_URL, application_name: "fairshift-fx-ecb" });
try {
  const quote = await fetchEcbDailyQuote();
  const { row } = await recordEcbQuote(drizzle(pool, { schema }), quote);
  console.log(`ECB reference rates for ${quote.rateDate} from ${ECB_DAILY_URL}: EUR/ZAR ${quote.eurZar}, EUR/USD ${quote.eurUsd}.`);
  console.log(row ? `Recorded: ${row.usdZarMicros / 1_000_000} ZAR per USD (rounded up at six decimals).` : "Already recorded for that date; the existing row is kept unchanged.");
  if (!isFreshRateDate(quote.rateDate, new Date())) console.log("This reference date is older than three business days, so payouts stay blocked.");
} catch (error) {
  console.error(`BLOCKED: no ECB reference rate recorded (${error instanceof Error ? error.message : String(error)}).`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
