import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../helpers/database";
import { payAgentCompany, testUser } from "../helpers/pay-agent";
import { auditEvents, businessPaypalConnections } from "@/server/db/schema";
import { UserFacingError } from "@/server/domain/errors";
import { businessPayPalStatus, businessPayoutCredentials, connectBusinessPayPal, openSecret, sealSecret, type TokenTest } from "@/server/payments/business-paypal";

// A business's own PayPal app (Owner decision, 11 Nov 2026). Synthetic credentials; no network.
afterEach(() => { vi.unstubAllEnvs(); });
const KEY = randomBytes(32);
const CLIENT = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", SECRET = "EFGH-synthetic-secret-value-WXYZ";
const accepted: TokenTest = async () => ({ appId: "APP-TEST000000000000" });
const refused: TokenTest = async () => { throw new UserFacingError("paypal-connect-refused", "refused"); };

describe("business PayPal connection", () => {
  it("seals the secret to its business, so another business can't open it", () => {
    const sealed = sealSecret(SECRET, KEY, "org-a");
    expect(sealed).not.toContain(SECRET);
    expect(openSecret(sealed, KEY, "org-a")).toBe(SECRET);
    expect(() => openSecret(sealed, KEY, "org-b")).toThrow();
    expect(() => openSecret(sealed, randomBytes(32), "org-a")).toThrow();
  });

  it("connects only for the Owner after a successful test, replaces an earlier one, and never shows or logs the secret", async () => {
    const t = await createTestDatabase();
    try {
      vi.stubEnv("FAIRSHIFT_CREDENTIALS_KEY", KEY.toString("base64"));
      const manager = (await payAgentCompany(t.db)).scopes[0];
      const owner = { organisationId: manager.organisationId, userId: await testUser(t.db), role: "OWNER" };
      const form = { clientId: CLIENT, secret: SECRET, senderEmail: "Fs-Jacaranda-Table@business.example.com" };
      // Nothing connected: no payout credentials, and no fallback to the platform app.
      expect(await businessPayoutCredentials(t.db, owner.organisationId)).toBeNull();
      await expect(connectBusinessPayPal(t.db, { ...owner, role: "MANAGER" }, form, accepted)).rejects.toMatchObject({ feedback: "paypal-connect-owner" });
      await expect(connectBusinessPayPal(t.db, owner, form, refused)).rejects.toMatchObject({ feedback: "paypal-connect-refused" });
      expect(await t.db.select().from(businessPaypalConnections)).toHaveLength(0);

      const first = await connectBusinessPayPal(t.db, owner, form, accepted);
      expect(first).toMatchObject({ appId: "APP-TEST000000000000", senderEmail: "fs-jacaranda-table@business.example.com", secretLast4: "WXYZ" });
      const second = await connectBusinessPayPal(t.db, owner, { ...form, secret: "ANOTHER-synthetic-secret-9876" }, accepted);
      const rows = await t.db.select().from(businessPaypalConnections);
      expect(rows).toHaveLength(2);
      expect(rows.filter(row => !row.disconnectedAt).map(row => row.id)).toEqual([second.id]);
      for (const row of rows) expect(row.secretSealed).not.toMatch(/synthetic-secret/);

      const status = await businessPayPalStatus(t.db, owner.organisationId);
      expect(status).toMatchObject({ secretLast4: "9876", clientIdTail: "6789", senderEmail: "fs-jacaranda-table@business.example.com" });
      expect(JSON.stringify(status)).not.toMatch(/synthetic-secret|AbCdEf/);
      expect(await businessPayoutCredentials(t.db, owner.organisationId)).toMatchObject({ connectionId: second.id, clientId: CLIENT, secret: "ANOTHER-synthetic-secret-9876" });

      const audits = await t.db.select().from(auditEvents).where(eq(auditEvents.action, "PAYPAL_BUSINESS_CONNECTED"));
      expect(audits).toHaveLength(2);
      expect(JSON.stringify(audits)).not.toMatch(/synthetic-secret/);

      // Without the server key, nothing can be opened: payouts are blocked rather than sent another way.
      vi.stubEnv("FAIRSHIFT_CREDENTIALS_KEY", "");
      expect(await businessPayoutCredentials(t.db, owner.organisationId)).toBeNull();
    } finally { await t.close(); }
  });
});
