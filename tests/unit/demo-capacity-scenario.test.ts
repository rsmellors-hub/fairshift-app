import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { demoCapacityScenario } from "@/server/demo/capacity-scenario";
import { SA_REFERENCE_ORGANISATION, saReferenceLocation } from "@/server/reference/sa-reference";

// The DEMO capacity scenario (Owner instruction, 8 November 2026): synthetic, for the fictional demo
// business only, and only while it is a configured demo organisation.
const ORG = SA_REFERENCE_ORGANISATION.id, ROSEBANK = saReferenceLocation("SA01").id, SANDTON = saReferenceLocation("SA02").id;
const TZ = "Africa/Johannesburg";
const asDemo = (organisationId: string) => {
  vi.stubEnv("FAIRSHIFT_DEPLOYMENT_MODE", "HOSTED_SANDBOX_DEMO"); vi.stubEnv("FAIRSHIFT_SANDBOX_ORGANISATION_ID", organisationId);
  vi.stubEnv("PAYPAL_ENV", "sandbox"); vi.stubEnv("PAYPAL_ENVIRONMENT", "sandbox"); vi.stubEnv("FAIRSHIFT_PUBLIC_DEMO", "");
};
afterEach(() => { vi.unstubAllEnvs(); });

describe("DEMO capacity scenario", () => {
  it("exists only at the fictional demo business's Rosebank location, and only while that business is a demo organisation", () => {
    const now = new Date("2026-11-08T08:00:00Z");
    vi.stubEnv("FAIRSHIFT_DEPLOYMENT_MODE", "LIVE_CUSTOMER");
    expect(demoCapacityScenario({ organisationId: ORG, outletId: ROSEBANK, timeZone: TZ, now })).toBeNull();
    asDemo(ORG);
    expect(demoCapacityScenario({ organisationId: ORG, outletId: ROSEBANK, timeZone: TZ, now })).toMatchObject({
      demo: true, status: "ACCEPTED", effectType: "CAPACITY", severity: "HIGH", closureLikely: true, direction: null, sizeBand: null,
      validFrom: "2026-11-09", validTo: "2026-11-09", name: "DEMO scenario: planned water interruption (synthetic)", responseId: null, use: "ALERT",
    });
    expect(demoCapacityScenario({ organisationId: ORG, outletId: SANDTON, timeZone: TZ, now })).toBeNull();
    // Another business configured as the demo never gets it, and the fictional business then doesn't either.
    const other = randomUUID();
    asDemo(other);
    expect(demoCapacityScenario({ organisationId: other, outletId: ROSEBANK, timeZone: TZ, now })).toBeNull();
    expect(demoCapacityScenario({ organisationId: ORG, outletId: ROSEBANK, timeZone: TZ, now })).toBeNull();
  });

  it("is always dated tomorrow, Johannesburg time", () => {
    asDemo(ORG);
    // 23:30 UTC on 8 November is 01:30 on 9 November in Johannesburg, so tomorrow is 10 November.
    expect(demoCapacityScenario({ organisationId: ORG, outletId: ROSEBANK, timeZone: TZ, now: new Date("2026-11-08T23:30:00Z") })).toMatchObject({ validFrom: "2026-11-10", validTo: "2026-11-10", key: "demo_capacity_2026-11-10" });
  });
});
