import { randomBytes, randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../helpers/database";
import { entitled } from "../helpers/onboarding";
import { resolveScope } from "@/server/auth/access";
import { requireScope } from "@/server/auth/request";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { businessPaypalConnections, memberships, organisations, outlets, subscriptions, users } from "@/server/db/schema";
import { connectPayPalAction, testPayPalAction } from "@/app/settings-actions";
import { OwnerWorkspace } from "@/app/owner/workspace";

// Business settings › Payouts (12 Nov 2026): the Owner connects the business's own PayPal Sandbox app.
// Synthetic credentials; PayPal's token endpoint is an in-process double.
vi.mock("@/server/auth/request", () => ({ requireScope: vi.fn() }));
vi.mock("@/server/db/client", () => ({ getDatabase: vi.fn() }));
vi.mock("@/server/config/env", () => ({ getConfigurationStatus: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); }, notFound: () => { throw new Error("NOT_FOUND"); } }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetAllMocks(); });

const SECRET = "SYNTHETIC-settings-secret-QRST";
const form = (values: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(values)) f.set(k, v); return f; };
const decode = (html: string) => html.replaceAll("&#x27;", "'").replaceAll("&amp;", "&");

describe("Business settings › Payouts", () => {
  it("connects the Owner's PayPal app after a token test, shows only the last four characters, and tests it again", async () => {
    const t = await createTestDatabase();
    try {
      vi.stubEnv("FAIRSHIFT_CREDENTIALS_KEY", randomBytes(32).toString("base64"));
      vi.stubEnv("FAIRSHIFT_PAYOUT_SENDER", "business");
      const tokenRequests: string[] = [];
      vi.stubGlobal("fetch", vi.fn(async (url: string) => { tokenRequests.push(url); return new Response(JSON.stringify({ access_token: "token", app_id: "APP-SETTINGS00000", scope: "https://uri.paypal.com/payments/payouts" }), { status: 200 }); }));
      const organisationId = randomUUID(), outletId = randomUUID(), userId = randomUUID(), membershipId = randomUUID();
      await t.db.insert(organisations).values({ id: organisationId, name: "Settings Cafe", country: "South Africa" });
      await t.db.insert(subscriptions).values({ id: randomUUID(), organisationId, requestId: randomUUID() });
      await entitled(t.db, organisationId);
      await t.db.insert(outlets).values({ id: outletId, organisationId, name: "Rosebank", timezone: "Africa/Johannesburg" });
      await t.db.insert(users).values({ id: userId, email: `owner-${userId.slice(0, 6)}@example.test`, name: "Owner", passwordHash: "x", emailVerifiedAt: new Date() });
      await t.db.insert(memberships).values({ id: membershipId, userId, organisationId, role: "OWNER" });
      const owner = await resolveScope(t.db, userId, membershipId, outletId);
      vi.mocked(getDatabase).mockReturnValue(t.db);
      vi.mocked(getConfigurationStatus).mockReturnValue({ databaseConfigured: true, paypalPayoutConfigured: true } as ReturnType<typeof getConfigurationStatus>);
      vi.mocked(requireScope).mockResolvedValue(owner);

      const before = decode(renderToStaticMarkup(await OwnerWorkspace({ area: "settings" })));
      expect(before).toContain("Connect your PayPal (Sandbox)");
      expect(before).toContain("Nothing yet. Connect your PayPal to pay your team.");
      expect(before).toContain("Not connected");

      const redirect = String(await connectPayPalAction(form({ clientId: "SettingsClientId-0123456789", secret: SECRET, senderEmail: "fs-settings-cafe@business.example.com" })).catch((error: Error) => error.message));
      expect(redirect).toBe("REDIRECT:/owner/settings?status=paypal-connected#payouts");
      expect(tokenRequests).toEqual(["https://api-m.sandbox.paypal.com/v1/oauth2/token"]);
      expect(await t.db.select().from(businessPaypalConnections)).toHaveLength(1);

      const after = decode(renderToStaticMarkup(await OwnerWorkspace({ area: "settings", status: "paypal-connected" })));
      expect(after).toContain("Your PayPal Sandbox account, fs-settings-cafe@business.example.com.");
      expect(after).toContain("APP-SETTINGS00000 · client ID ending 6789 · secret ending QRST");
      expect(after).toContain("Replace your PayPal (Sandbox)");
      expect(after).toContain("Test connection");
      expect(after).not.toContain("SYNTHETIC-settings-secret");
      expect(after).not.toContain("SettingsClientId");

      expect(String(await testPayPalAction().catch((error: Error) => error.message))).toBe("REDIRECT:/owner/settings?status=paypal-tested#payouts");
      expect(tokenRequests).toHaveLength(2);

      // A refused test saves nothing and keeps the earlier connection.
      vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
      expect(String(await connectPayPalAction(form({ clientId: "OtherClientId-0123456789", secret: "SYNTHETIC-wrong-secret", senderEmail: "x@business.example.com" })).catch((error: Error) => error.message)))
        .toBe("REDIRECT:/owner/settings?status=paypal-connect-refused#payouts");
      expect(await t.db.select().from(businessPaypalConnections)).toHaveLength(1);
    } finally { await t.close(); }
  });
});
