import { z } from "zod";
import { UserFacingError } from "@/server/domain/errors";

export type DeploymentMode = "LIVE_CUSTOMER" | "HOSTED_SANDBOX_DEMO";

// Deployment purpose is server-owned. Missing or unrecognised configuration fails
// closed, including in development and test; request input is never consulted.
export function deploymentMode(): DeploymentMode {
  return process.env.FAIRSHIFT_DEPLOYMENT_MODE === "HOSTED_SANDBOX_DEMO"
    ? "HOSTED_SANDBOX_DEMO" : "LIVE_CUSTOMER";
}

export class SandboxIsolationError extends UserFacingError {
  readonly code = "SANDBOX_ISOLATION_REQUIRED";
  readonly status = 403;
  constructor() {
    super("sandbox-isolation-required", "Sandbox payments are unavailable in this environment or account.");
  }
}

export function sandboxOrganisationId(): string | null {
  if (deploymentMode() !== "HOSTED_SANDBOX_DEMO") return null;
  const id = z.uuid().safeParse(process.env.FAIRSHIFT_SANDBOX_ORGANISATION_ID);
  // Do not silently reinterpret conflicting provider settings as Sandbox or live.
  if (!id.success || [process.env.PAYPAL_ENV, process.env.PAYPAL_ENVIRONMENT]
    .some(value => value !== undefined && value !== "sandbox")) return null;
  return id.data;
}

export function assertSandboxDeployment(): string {
  const id = sandboxOrganisationId();
  if (!id) throw new SandboxIsolationError();
  return id;
}

export function assertSandboxOrganisation(organisationId: string) {
  if (assertSandboxDeployment() !== organisationId) throw new SandboxIsolationError();
}

// Owner decision 10 Nov 2026: on the hosted PayPal Sandbox deployment, every business may use Sandbox
// subscriptions, the Pay Agent and payouts (with daily payout caps, sandbox-limits.ts). Setting
// FAIRSHIFT_SANDBOX_SCOPE=DEMO_ONLY restores demo-only isolation at once. Live customer mode never opens.
export function sandboxOpenToAllBusinesses() {
  return sandboxOrganisationId() !== null && process.env.FAIRSHIFT_SANDBOX_SCOPE !== "DEMO_ONLY";
}
export function sandboxBusinessAllowed(organisationId: string) {
  const id = sandboxOrganisationId();
  return !!id && (id === organisationId || sandboxOpenToAllBusinesses());
}
export function assertSandboxBusiness(organisationId: string) {
  assertSandboxDeployment();
  if (!sandboxBusinessAllowed(organisationId)) throw new SandboxIsolationError();
}

// scope must come from server-side authentication. Public persona sessions never
// acquire provider-write authority, even inside the isolated demo deployment.
export function assertSandboxFinancialScope(scope: { organisationId: string; demo?: unknown }) {
  assertSandboxBusiness(scope.organisationId);
  if (scope.demo) throw new SandboxIsolationError();
}
