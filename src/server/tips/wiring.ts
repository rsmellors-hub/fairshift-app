import type { Scope } from "@/server/auth/access";
import type { Database } from "@/server/db/client";
import { getPayPalPayoutClient } from "@/server/integrations/paypal/factory";
import { mintPayAgentCredentialForManager, mintPayAgentCredentialForRecovery, payAgentServiceVerifier } from "@/server/pay-agent/identity";
import { payAgentModelFor } from "@/server/pay-agent/model";
import { afterResponse, type AfterResponse } from "@/server/pay-agent/service";
import { createTipAgent, settleReleasedLineHold, sweepTipAgentEvents, type TipAgent } from "./agent";
import type { tipHolds } from "@/server/db/schema";

// Production wiring of the Pay Agent's tip check: the same server-minted service identity, the
// configured model (only for the isolated Sandbox demo organisation) and the shared payout engine,
// whose PayPal client is constructed only if a live, non-dry-run payout is actually reached.
export function tipAgentFor(db: Database): TipAgent {
  return createTipAgent({ db, identityVerifier: payAgentServiceVerifier, model: payAgentModelFor, paypal: getPayPalPayoutClient });
}

type OwnerScope = Pick<Scope, "userId" | "organisationId" | "locationId" | "role" | "demo">;

// After the Owner's import (or retry, or hold release) has committed: the tip checks run once the
// response is sent. The durable events are the source of truth; recovery takes up anything left.
export function scheduleTipEvents(agent: TipAgent, scope: OwnerScope, eventIds: string[], options: { manual?: boolean } = {}, schedule: AfterResponse = afterResponse) {
  if (!eventIds.length || scope.demo || scope.role !== "OWNER") return false;
  const credential = mintPayAgentCredentialForManager(scope);
  schedule(async () => { for (const eventId of eventIds) await agent.process({ eventId }, credential, options); });
  return true;
}

export function scheduleReleasedLineHold(db: Database, scope: OwnerScope, hold: typeof tipHolds.$inferSelect, schedule: AfterResponse = afterResponse) {
  schedule(() => settleReleasedLineHold(db, getPayPalPayoutClient, scope, hold));
}

export function sweepTips(db: Database) {
  return sweepTipAgentEvents(db, tipAgentFor(db), mintPayAgentCredentialForRecovery);
}
