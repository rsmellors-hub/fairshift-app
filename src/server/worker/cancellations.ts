import { and, eq, inArray } from "drizzle-orm";
import type { Scope } from "@/server/auth/access";
import type { DatabaseSession } from "@/server/db/client";
import { auditEvents, users } from "@/server/db/schema";

// Who cancelled each of the worker's cancelled shifts, when, under which rule and the cancellation pay its
// terms set (design: worker Shifts), from the cancellation's own audit row. Only the worker's own shifts.
export type Cancellation = { by: string | null; at: Date; percent: number | null; windowMinutes: number | null; dueMinor: number | null; currencyCode: string | null };

export async function workerCancellations(db: DatabaseSession, scope: Scope): Promise<Map<string, Cancellation>> {
  if (!scope.workerId) return new Map();
  const rows = await db.select({ shiftId: auditEvents.entityId, metadata: auditEvents.metadata, createdAt: auditEvents.createdAt }).from(auditEvents)
    .where(and(eq(auditEvents.organisationId, scope.organisationId), eq(auditEvents.action, "SHIFT_CANCELLED")));
  const mine = rows.filter(row => Array.isArray((row.metadata as { workerIds?: unknown }).workerIds) && ((row.metadata as { workerIds: string[] }).workerIds).includes(scope.workerId!));
  const actorIds = [...new Set(mine.map(row => (row.metadata as { actorUserId?: string | null }).actorUserId).filter((id): id is string => !!id))];
  const names = actorIds.length ? new Map((await db.select({ id: users.id, firstName: users.firstName }).from(users).where(inArray(users.id, actorIds))).map(row => [row.id, row.firstName])) : new Map<string, string | null>();
  return new Map(mine.map(row => {
    const m = row.metadata as { actorUserId?: string | null; actorRole?: string | null; cancellationPercent?: number | null; cancellationWindowMinutes?: number | null; dueMinor?: number | null; currencyCode?: string | null };
    const name = m.actorUserId ? names.get(m.actorUserId) ?? null : null;
    return [row.shiftId!, { by: name ? `${name}${m.actorRole === "OWNER" ? " (Owner)" : m.actorRole === "MANAGER" ? " (manager)" : ""}` : m.actorRole === "OWNER" ? "The Owner" : "Your manager",
      at: row.createdAt, percent: m.cancellationPercent ?? null, windowMinutes: m.cancellationWindowMinutes ?? null, dueMinor: m.dueMinor ?? null, currencyCode: m.currencyCode ?? null }];
  }));
}
