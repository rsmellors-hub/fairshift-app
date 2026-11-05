import { vi } from "vitest";
import { DEMO_ORGANISATION_ID } from "@/server/constants";

// Explicit server authority for mocked Sandbox regression journeys. Never imported
// by application code. Each fixture uses a disposable database and fake adapters.
export function sandboxFixture(organisationId = DEMO_ORGANISATION_ID) {
  vi.stubEnv("FAIRSHIFT_DEPLOYMENT_MODE", "HOSTED_SANDBOX_DEMO");
  vi.stubEnv("FAIRSHIFT_SANDBOX_ORGANISATION_ID", organisationId);
  vi.stubEnv("PAYPAL_ENV", "sandbox");
  vi.stubEnv("PAYPAL_ENVIRONMENT", "sandbox");
}
