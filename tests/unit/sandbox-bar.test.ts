import { randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Scope } from "@/server/auth/access";
import { shellStrips } from "@/app/components/shell-chrome";

vi.mock("next/navigation", () => ({ redirect: vi.fn(), notFound: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// The Sandbox demo business's bar for signed-in accounts (12 Nov 2026): Reset demo is offered only while
// the public demo is on, since resetDemo refuses it otherwise. The bar itself stays.
const ORG = randomUUID();
const scope = { userId: randomUUID(), organisationId: ORG, locationId: randomUUID(), role: "OWNER", organisationName: "Jacaranda Table Demo", locationName: "Rosebank" } as Scope;
const bar = () => renderToStaticMarkup(shellStrips(scope, "").notice!);
afterEach(() => vi.unstubAllEnvs());

describe("Sandbox bar", () => {
  it("has no Reset demo while the public demo is off, and offers it while it is on", () => {
    vi.stubEnv("FAIRSHIFT_DEPLOYMENT_MODE", "HOSTED_SANDBOX_DEMO"); vi.stubEnv("FAIRSHIFT_SANDBOX_ORGANISATION_ID", ORG);
    vi.stubEnv("PAYPAL_ENV", "sandbox"); vi.stubEnv("PAYPAL_ENVIRONMENT", "sandbox");
    vi.stubEnv("FAIRSHIFT_PUBLIC_DEMO", "off");
    expect(bar()).toContain("Sandbox demo business");
    expect(bar()).not.toContain("Reset demo");

    vi.stubEnv("FAIRSHIFT_PUBLIC_DEMO", "enabled"); vi.stubEnv("FAIRSHIFT_DEMO_ORGANISATION_ID", ORG);
    vi.stubEnv("FAIRSHIFT_DEMO_OWNER_MEMBERSHIP_ID", randomUUID()); vi.stubEnv("FAIRSHIFT_DEMO_MANAGER_MEMBERSHIP_ID", randomUUID()); vi.stubEnv("FAIRSHIFT_DEMO_WORKER_MEMBERSHIP_ID", randomUUID());
    expect(bar()).toContain("Reset demo");
  });
});
