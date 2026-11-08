import { AccessError, type Scope } from "@/server/auth/access";
import { audited, uuidOrNull } from "@/server/auth/audit-actor";
import { UserFacingError } from "@/server/domain/errors";
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

// An Owner's retry of a tip check can lead to a PayPal payout, so each request leaves one audit row (who,
// role, session type, time, outcome) before anything is scheduled. The run's own result is in the tip
// check's journal.
export async function retryTipCheck(db: Database, agent: TipAgent, scope: OwnerScope, eventId: string, schedule: AfterResponse = afterResponse) {
  const id = uuidOrNull(eventId);
  return audited(db, { organisationId: scope.organisationId, outletId: scope.locationId, action: "TIP_CHECK_RETRY_REQUESTED", entityType: "tip_agent_event", entityId: id,
    correlationId: id ? `tip-agent-event:${id}` : `tip-control:${scope.userId}`, actor: scope }, async () => {
    if (scope.demo || scope.role !== "OWNER") throw new AccessError();
    if (!id) throw new UserFacingError("tip-check-unavailable", "This check isn't available.");
    return scheduleTipEvents(agent, scope, [id], { manual: true }, schedule);
  }, () => "RUN_SCHEDULED");
}

export function scheduleReleasedLineHold(db: Database, scope: OwnerScope, hold: typeof tipHolds.$inferSelect, schedule: AfterResponse = afterResponse) {
  schedule(() => settleReleasedLineHold(db, getPayPalPayoutClient, scope, hold));
}

export function sweepTips(db: Database) {
  return sweepTipAgentEvents(db, tipAgentFor(db), mintPayAgentCredentialForRecovery);
}
