import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../helpers/database";
import { createOrganisation } from "../helpers/onboarding";
import { registerIdentity } from "@/server/auth/identity";
import { createLocation } from "@/server/billing/locations";
import { outlets, users } from "@/server/db/schema";

const uk = { locationCity: "Leeds", locationProvince: "", locationPostalCode: "LS1 6AZ", locationCountry: "United Kingdom" };

describe("location time zones", () => {
  it("sets new locations from the location or organisation country instead of always Johannesburg", async () => {
    const t = await createTestDatabase();
    try {
      const owner = async (email: string) => {
        const user = await registerIdentity(t.db, { email, password: "long-test-password-42" });
        await t.db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, user.id));
        return user;
      };
      const ukOwner = await owner("uk-owner@example.test");
      const ukOrg = await createOrganisation(t.db, ukOwner.id, { name: "UK company", locationName: "Leeds", ...uk });
      const [first] = await t.db.select().from(outlets).where(eq(outlets.id, ukOrg.locationId));
      expect(first.timezone).toBe("Europe/London");
      const added = await createLocation(t.db, { userId: ukOwner.id, organisationId: ukOrg.organisationId, role: "OWNER" }, { name: "Manchester" });
      expect(added.timezone).toBe("Europe/London");

      // The South African demonstration path keeps Africa/Johannesburg.
      const saOwner = await owner("sa-owner@example.test");
      const saOrg = await createOrganisation(t.db, saOwner.id, { name: "SA company", locationName: "Rosebank" });
      expect((await t.db.select().from(outlets).where(eq(outlets.id, saOrg.locationId)))[0].timezone).toBe("Africa/Johannesburg");
      expect((await createLocation(t.db, { userId: saOwner.id, organisationId: saOrg.organisationId, role: "OWNER" }, { name: "Sandton" })).timezone).toBe("Africa/Johannesburg");
    } finally { await t.close(); }
  }, 120_000);

  it("migration 0012 corrects hard-coded Johannesburg time zones only for United Kingdom locations", async () => {
    const client = new PGlite();
    try {
      const files = (await readdir(path.resolve("drizzle"))).filter(file => file.endsWith(".sql")).sort();
      const apply = async (file: string) => {
        for (const statement of (await readFile(path.resolve("drizzle", file), "utf8")).split("--> statement-breakpoint")) if (statement.trim()) await client.exec(statement);
      };
      for (const file of files.filter(file => file < "0012")) await apply(file);
      await client.exec(`
        INSERT INTO organisations (id, name, country) VALUES
          ('10000000-0000-4000-8000-0000000000a1', 'UK company', 'United Kingdom'),
          ('10000000-0000-4000-8000-0000000000a2', 'SA company', 'South Africa'),
          ('10000000-0000-4000-8000-0000000000a3', 'Unknown company', NULL);
        INSERT INTO outlets (id, organisation_id, name, timezone, country) VALUES
          ('20000000-0000-4000-8000-0000000000b1', '10000000-0000-4000-8000-0000000000a1', 'UK, no country', 'Africa/Johannesburg', NULL),
          ('20000000-0000-4000-8000-0000000000b2', '10000000-0000-4000-8000-0000000000a2', 'In England', 'Africa/Johannesburg', ' england '),
          ('20000000-0000-4000-8000-0000000000b3', '10000000-0000-4000-8000-0000000000a1', 'Abroad', 'Africa/Johannesburg', 'South Africa'),
          ('20000000-0000-4000-8000-0000000000b4', '10000000-0000-4000-8000-0000000000a2', 'Rosebank', 'Africa/Johannesburg', NULL),
          ('20000000-0000-4000-8000-0000000000b5', '10000000-0000-4000-8000-0000000000a3', 'Unknown', 'Africa/Johannesburg', NULL),
          ('20000000-0000-4000-8000-0000000000b6', '10000000-0000-4000-8000-0000000000a1', 'Explicit', 'UTC', NULL);`);
      await apply(files.find(file => file.startsWith("0012"))!);
      const rows = (await client.query<{ name: string; timezone: string }>("SELECT name, timezone FROM outlets ORDER BY id")).rows;
      expect(Object.fromEntries(rows.map(row => [row.name, row.timezone]))).toEqual({
        "UK, no country": "Europe/London", "In England": "Europe/London", Abroad: "Africa/Johannesburg",
        Rosebank: "Africa/Johannesburg", Unknown: "Africa/Johannesburg", Explicit: "UTC",
        "Rosebank Kitchen": "Africa/Johannesburg", // seeded South African demonstration outlet
      });
    } finally { await client.close(); }
  });
});
