import { randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../helpers/database";
import { OwnerWorkspace } from "@/app/owner/workspace";
import { requireScope } from "@/server/auth/request";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { eq } from "drizzle-orm";
import { outlets, users } from "@/server/db/schema";
import { registerIdentity } from "@/server/auth/identity";
import { createOrganisation } from "../helpers/onboarding";
import { getOwnerWorkspace } from "@/server/product/workspace";
import { provisionReferenceHistory } from "@/server/reference/provision";
import { REFERENCE_STORE_CODES } from "@/server/reference/uk-hospitality";

vi.mock("@/server/auth/request", () => ({ requireScope: vi.fn() }));
vi.mock("@/server/db/client", () => ({ getDatabase: vi.fn() }));
vi.mock("@/server/config/env", () => ({ getConfigurationStatus: vi.fn() }));
afterEach(() => vi.resetAllMocks());

describe("Owner pages with reference sales history", () => {
  it("counts and reports reference history by location without loading it row by row, scoped to the organisation", async () => {
    const t = await createTestDatabase();
    try {
      const user = await registerIdentity(t.db, { email: "reference-owner@example.test", password: "long-test-password-42" });
      await t.db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, user.id));
      const { organisationId, locationId } = await createOrganisation(t.db, user.id, { name: "Reference pages company", locationName: "Reference store 1", locationCity: "Leeds", locationProvince: "", locationPostalCode: "LS1 6AZ", locationCountry: "United Kingdom" });
      const extra = REFERENCE_STORE_CODES.slice(1).map((code, i) => ({ id: randomUUID(), organisationId, name: `Reference store ${i + 2}`, timezone: "Europe/London" }));
      await t.db.insert(outlets).values(extra);
      const [first] = await t.db.select().from(outlets).where(eq(outlets.id, locationId));
      // A United Kingdom location gets its time zone from its country, not from the loader.
      expect(first.timezone).toBe("Europe/London");
      const rows = [first, ...extra];
      const loaded = await provisionReferenceHistory(t.db, { organisationId, from: "2026-10-12", through: "2026-10-18",
        outlets: Object.fromEntries(REFERENCE_STORE_CODES.map((code, i) => [code, rows[i].id])) as Record<typeof REFERENCE_STORE_CODES[number], string> });

      const workspace = await getOwnerWorkspace(t.db, organisationId);
      expect(workspace.sales.length).toBeLessThanOrEqual(5);
      expect(workspace.sales.reduce((sum, row) => sum + row.records, 0)).toBe(loaded.expected);
      expect((await getOwnerWorkspace(t.db)).sales.every(row => row.source !== "REFERENCE")).toBe(true);

      vi.mocked(getDatabase).mockReturnValue(t.db);
      vi.mocked(getConfigurationStatus).mockReturnValue({ databaseConfigured: true } as ReturnType<typeof getConfigurationStatus>);
      vi.mocked(requireScope).mockResolvedValue({ userId: user.id, organisationId, locationId: rows[0].id, role: "OWNER", organisationName: "Reference pages company", locationName: rows[0].name });
      const reporting = renderToStaticMarkup(await OwnerWorkspace({ area: "reporting" }));
      expect(reporting).toContain("Reference sales history · synthetic");
      expect(reporting.match(/Reference sales history · synthetic/g)).toHaveLength(5);
      expect(reporting).toContain("7 trading days, 2026-10-12 to 2026-10-18");
      expect(reporting).toContain("£");
      expect(reporting).not.toContain("No commercial history available");
      const locations = renderToStaticMarkup(await OwnerWorkspace({ area: "locations" }));
      const uk01 = loaded.stores.find(store => store.code === "UK01")!;
      expect(locations).toContain(`${uk01.transactions} recorded commercial entries`);
    } finally { await t.close(); }
  }, 120_000);
});
