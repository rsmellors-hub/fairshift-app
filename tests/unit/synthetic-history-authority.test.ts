import { afterEach, expect, it, vi } from "vitest";
import { syntheticHistoryAllowed } from "@/server/intelligence/sales-history";

afterEach(() => vi.unstubAllEnvs());
it("requires a configured demo tenant and server-issued persona context", () => {
  const organisationId = "11111111-1111-4111-8111-111111111111";
  const demo = { persona: "OWNER" as const, group: "isolated-test" };
  vi.stubEnv("FAIRSHIFT_PUBLIC_DEMO", "");
  expect(syntheticHistoryAllowed({ organisationId, demo })).toBe(false);
  vi.stubEnv("FAIRSHIFT_PUBLIC_DEMO", "enabled");
  vi.stubEnv("FAIRSHIFT_DEMO_ORGANISATION_ID", organisationId);
  vi.stubEnv("FAIRSHIFT_DEMO_OWNER_MEMBERSHIP_ID", "22222222-2222-4222-8222-222222222222");
  vi.stubEnv("FAIRSHIFT_DEMO_MANAGER_MEMBERSHIP_ID", "33333333-3333-4333-8333-333333333333");
  vi.stubEnv("FAIRSHIFT_DEMO_WORKER_MEMBERSHIP_ID", "44444444-4444-4444-8444-444444444444");
  expect(syntheticHistoryAllowed({ organisationId, demo })).toBe(true);
  expect(syntheticHistoryAllowed({ organisationId })).toBe(false);
  expect(syntheticHistoryAllowed({ organisationId: "55555555-5555-4555-8555-555555555555", demo })).toBe(false);
});
