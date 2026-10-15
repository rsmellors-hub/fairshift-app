import { readFile } from "node:fs/promises";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

describe("commercial provenance migration", () => {
  it("preserves existing PayPal sales and constrains newly seeded history", async () => {
    const client = new PGlite();
    try {
      const base = await readFile(path.resolve("drizzle/0000_fairshift_paypal_inbound.sql"), "utf8");
      for (const statement of base.split("--> statement-breakpoint")) if (statement.trim()) await client.exec(statement);
      await client.exec(`INSERT INTO sale_transactions (
        id, internal_reference, outlet_id, paypal_order_id, paypal_capture_id, paypal_custom_id,
        currency_code, gross_amount_minor, provider_status, reconciliation_state, verification_state,
        provider_created_at, reconciled_at
      ) VALUES (
        '40000000-0000-4000-8000-000000000001', 'FS-OLD',
        '20000000-0000-4000-8000-000000000001', 'ORDER-OLD', 'CAPTURE-OLD', 'FS-OLD',
        'USD', 500, 'COMPLETED', 'RECONCILED', 'VERIFIED', now(), now()
      )`);
      const migration = await readFile(path.resolve("drizzle/0001_commercial_provenance.sql"), "utf8");
      for (const statement of migration.split("--> statement-breakpoint")) if (statement.trim()) await client.exec(statement);
      const legacy = await client.query(`SELECT source, paypal_custom_id, verification_state FROM sale_transactions WHERE id = '40000000-0000-4000-8000-000000000001'`);
      expect(legacy.rows[0]).toMatchObject({ source: "PAYPAL_SANDBOX", paypal_custom_id: "FS-OLD", verification_state: "VERIFIED" });
      await expect(client.exec(`INSERT INTO sale_transactions (
        id, internal_reference, outlet_id, currency_code, gross_amount_minor, provider_status,
        verification_state, reconciliation_state, source
      ) VALUES (
        '40000000-0000-4000-8000-000000000002', 'DEMO-BAD',
        '20000000-0000-4000-8000-000000000001', 'USD', 500, 'DEMO_SEEDED',
        'VERIFIED', 'RECONCILED', 'DEMO_SEEDED'
      )`)).rejects.toThrow();
      await expect(client.exec(`INSERT INTO sale_transactions (
        id, internal_reference, outlet_id, currency_code, gross_amount_minor, provider_status,
        verification_state, reconciliation_state
      ) VALUES (
        '40000000-0000-4000-8000-000000000003', 'PAYPAL-BAD',
        '20000000-0000-4000-8000-000000000001', 'USD', 500, 'COMPLETED',
        'VERIFIED', 'RECONCILED'
      )`)).rejects.toThrow();
    } finally {
      await client.close();
    }
  });
});
