import { createHash } from "node:crypto";

import { DEMO_OUTLET_ID } from "@/server/constants";
import type { Database } from "@/server/db/client";
import { saleTransactions } from "@/server/db/schema";
import { shiftDate } from "@/server/intelligence/forecast";

export const DEMO_AS_OF = new Date("2026-10-15T08:00:00Z");
export const DEMO_TARGET_DATE = "2026-10-16";
export const DEMO_SEED_VERSION = "commercial-history-v1";

// Opt-in, idempotent synthetic receipts. No provider IDs, provider timestamps or
// verification claims. Same normalized table and forecasting function as PayPal.
export async function seedDemoHistory(db: Database) {
  const rows: (typeof saleTransactions.$inferInsert)[] = [];
  for (let day = 0; day < 56; day++) {
    const date = shiftDate("2026-08-20", day);
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    const count = [30, 42, 48, 54, 72, 80, 88][weekday] + Math.floor(day / 7) * 2;
    for (let receipt = 0; receipt < count; receipt++) {
      const reference = `DEMO-${DEMO_SEED_VERSION}-${date}-${receipt}`;
      const hash = createHash("sha256").update(reference).digest("hex");
      rows.push({
        id: `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`,
        internalReference: reference, outletId: DEMO_OUTLET_ID, source: "DEMO_SEEDED",
        currencyCode: "USD", grossAmountMinor: 6000 + (receipt % 5) * 250,
        providerStatus: "DEMO_SEEDED", verificationState: "PENDING", reconciliationState: "NOT_RECONCILED",
        createdAt: new Date(`${date}T10:${String(receipt % 60).padStart(2, "0")}:00Z`),
      });
    }
  }
  return db.transaction(async (tx) => {
    let inserted = 0;
    // Bound parameter counts and avoid one oversized INSERT for PostgreSQL and
    // PGlite while keeping the complete seed operation atomic.
    for (let i = 0; i < rows.length; i += 500) {
      const result = await tx.insert(saleTransactions).values(rows.slice(i, i + 500))
        .onConflictDoNothing({ target: saleTransactions.internalReference }).returning({ id: saleTransactions.id });
      inserted += result.length;
    }
    return { seedVersion: DEMO_SEED_VERSION, inserted, expected: rows.length };
  });
}
