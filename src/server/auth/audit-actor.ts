import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AccessError } from "@/server/auth/access";
import type { DatabaseSession } from "@/server/db/client";
import { auditEvents } from "@/server/db/schema";
import { UserFacingError } from "@/server/domain/errors";
import { PayPalApiError } from "@/server/integrations/paypal/client";
import { PayPalPayoutError } from "@/server/integrations/paypal/payout-client";

// Every action a person takes that can lead to a PayPal call leaves an audit row: who did it, their role
// in the organisation at the time, whether the request came from a signed-in session or the public demo,
// the time (the row's created_at) and the outcome, whether it went ahead or was refused.
export type AuditActorScope = { userId: string; role: string; demo?: unknown };
export type AuditTarget = {
  organisationId: string; outletId?: string | null; action: string; entityType: string; entityId?: string | null; correlationId: string;
  actor: AuditActorScope; detail?: Record<string, unknown>;
};

// Public demo visitors share their persona's user, so a demo row also names the visitor's demo session
// group (the DEMO_SESSION_ENTERED row's entity ID).
export function auditActor(scope: AuditActorScope) {
  if (!scope.demo) return { actorUserId: scope.userId, actorRole: scope.role, sessionType: "SIGNED_IN" } as const;
  const group = (scope.demo as { group?: unknown }).group;
  return { actorUserId: scope.userId, actorRole: scope.role, sessionType: "PUBLIC_DEMO", demoGroup: typeof group === "string" ? group : null } as const;
}

export async function auditAction(db: DatabaseSession, input: AuditTarget & { outcome: string }) {
  await db.insert(auditEvents).values({
    id: randomUUID(), organisationId: input.organisationId, outletId: input.outletId ?? null, action: input.action, entityType: input.entityType,
    entityId: input.entityId ?? null, correlationId: input.correlationId, metadata: { ...auditActor(input.actor), outcome: input.outcome, ...input.detail },
  });
}

// What a request found while it ran (the record it acted on), added to its audit row.
export type AuditFound = { entityId?: string | null; correlationId?: string; detail?: Record<string, unknown> };

// Runs a person's request and records it exactly once, whatever happens: the outcome is what `outcome`
// makes of the result, or the refusal. The row is written after the request's own transactions, so a
// refusal is recorded too and is never rolled back with the work it refused. Recording a refusal never
// replaces it: if that row can't be written (for instance, a scope naming no stored organisation), the
// refusal still stands and the failure is logged. A row that can't be written after work that went ahead
// fails the request loudly; the work's own records (a payout's reservation row) are already stored.
export async function audited<T>(db: DatabaseSession, target: AuditTarget, run: (found: AuditFound) => Promise<T>, outcome: (result: T) => string): Promise<T> {
  const found: AuditFound = {};
  const row = (recorded: string) => ({ ...target, ...found, detail: { ...target.detail, ...found.detail }, outcome: recorded });
  let result: T;
  try {
    result = await run(found);
  } catch (error) {
    await auditAction(db, row(refusalOutcome(error))).catch(auditError => {
      console.error("Audit row for a refused request was not written; the refusal stands.", { action: target.action, error: auditError instanceof Error ? auditError.name : "unknown" });
    });
    throw error;
  }
  await auditAction(db, row(outcome(result)));
  return result;
}

// A refusal's outcome: the user-facing reason code where there is one, or the provider's error code.
// Never the message or a provider body.
export function refusalOutcome(error: unknown): string {
  if (error instanceof UserFacingError) return `REFUSED:${error.feedback}`;
  if (error instanceof AccessError) return "REFUSED:access-denied";
  if (error instanceof PayPalApiError || error instanceof PayPalPayoutError) return `PROVIDER_ERROR:${error.code}`;
  if (error instanceof z.ZodError) return "REFUSED:invalid-input";
  if (error instanceof Error && error.cause) {
    const cause = refusalOutcome(error.cause);
    if (cause.startsWith("PROVIDER_ERROR")) return cause;
  }
  return "REFUSED";
}

// An ID from a form, kept only when it is a UUID, so a row never stores arbitrary input.
export const uuidOrNull = (value: unknown) => typeof value === "string" && z.uuid().safeParse(value).success ? value : null;
