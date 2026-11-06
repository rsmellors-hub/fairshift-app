import { AccessError, type Scope } from "@/server/auth/access";
import { serviceIdentitySchema, type PayAgentIdentity, type PayAgentIdentityVerifier } from "./contract";

// The FairShift Pay Agent's service identity. A credential is an opaque object minted in this
// server process and recognised only by reference, so it cannot be serialised, forged or sent
// by a browser, a worker or a public demo persona: a request can carry data, never this object.
// It is minted only (a) for an authenticated, non-demo Owner or Manager's own confirmation,
// retry or hold decision, scoped to that person's organisation and location, and (b) for
// server-side recovery of an existing durable event, scoped to that event's own location.

export type PayAgentServiceCredential = Readonly<{ organisationId: string; locationId: string }>;
const minted = new WeakSet<object>();

function mint(scope: { organisationId: string; locationId: string }): PayAgentServiceCredential {
  const credential = Object.freeze({ organisationId: scope.organisationId, locationId: scope.locationId });
  minted.add(credential);
  return credential;
}

export function mintPayAgentCredentialForManager(scope: Pick<Scope, "organisationId" | "locationId" | "role" | "demo">): PayAgentServiceCredential {
  if (scope.demo || (scope.role !== "OWNER" && scope.role !== "MANAGER")) throw new AccessError();
  return mint(scope);
}

export function mintPayAgentCredentialForRecovery(event: { organisationId: string; outletId: string }): PayAgentServiceCredential {
  return mint({ organisationId: event.organisationId, locationId: event.outletId });
}

export const payAgentServiceVerifier: PayAgentIdentityVerifier = {
  async authenticate(credential: unknown): Promise<PayAgentIdentity | null> {
    if (typeof credential !== "object" || credential === null || !minted.has(credential)) return null;
    const { organisationId, locationId } = credential as PayAgentServiceCredential;
    const identity = serviceIdentitySchema.safeParse({ kind: "service", subject: "fairshift-pay-agent", organisationId, locationId });
    return identity.success ? identity.data : null;
  },
};
