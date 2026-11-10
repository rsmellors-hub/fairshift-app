import { and, eq, gte, ne } from "drizzle-orm";
import type { DatabaseSession } from "@/server/db/client";
import { workPayouts } from "@/server/db/schema";
import { UserFacingError } from "@/server/domain/errors";
import { latestFxReferenceRate } from "@/server/fx/reference-rates";
import { sandboxOrganisationId } from "@/server/config/deployment";

// Sandbox payout guardrails for every business on the hosted PayPal Sandbox deployment (Owner decision
// 10 Nov 2026, item 1): at most 5 payouts and US$100 a day per business (UTC day), counted from the
// payouts it has reserved. A GBP payout is converted at the latest ECB EUR/USD and EUR/GBP. Any other
// currency can't be checked, so it isn't sent. Nothing here changes an amount.
export const SANDBOX_PAYOUT_LIMITS = { payoutsPerDay: 5, usdMinorPerDay: 100_00 } as const;

// Until an ECB GBP rate is recorded, each £1 counts as US$2.10 for the cap: above any GBP/USD rate in
// decades, so the cap is only ever stricter. Used for the cap only, never for an amount paid.
export const GBP_CAP_FALLBACK_USD_PER_GBP = 2.1;
type Leg = { providerCurrency: string; providerAmountMinor: number };
export async function usdMinorOf(db: DatabaseSession, leg: Leg) {
  if (leg.providerCurrency === "USD") return leg.providerAmountMinor;
  if (leg.providerCurrency === "GBP") {
    const rate = await latestFxReferenceRate(db);
    return Math.ceil(leg.providerAmountMinor * (rate?.eurGbp ? Number(rate.eurUsd) / Number(rate.eurGbp) : GBP_CAP_FALLBACK_USD_PER_GBP));
  }
  return null;
}

// The guardrails come with opening the Sandbox to every business, so they apply to businesses other than
// the configured demo business, whose Sandbox payouts were already isolated and stay as they were.
export async function assertSandboxPayoutLimits(db: DatabaseSession, organisationId: string, leg: Leg, now = new Date(), excludePayoutId?: string) {
  if (sandboxOrganisationId() === organisationId) return;
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const today = await db.select({ providerCurrency: workPayouts.providerCurrency, providerAmountMinor: workPayouts.providerAmountMinor }).from(workPayouts)
    .where(and(eq(workPayouts.organisationId, organisationId), gte(workPayouts.reservedAt, since), excludePayoutId ? ne(workPayouts.id, excludePayoutId) : undefined));
  if (today.length + 1 > SANDBOX_PAYOUT_LIMITS.payoutsPerDay) throw new UserFacingError("sandbox-payout-limit", `This business has sent ${SANDBOX_PAYOUT_LIMITS.payoutsPerDay} Sandbox payouts today, the daily limit. It can send more tomorrow.`);
  const amounts = await Promise.all([...today, leg].map(row => usdMinorOf(db, row)));
  if (amounts.some(value => value === null)) throw new UserFacingError("sandbox-payout-limit-unchecked", "This payout can't be checked against the Sandbox's US$100 daily limit yet (no exchange rate for its currency today), so it isn't sent.");
  const total = amounts.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  if (total > SANDBOX_PAYOUT_LIMITS.usdMinorPerDay) throw new UserFacingError("sandbox-payout-limit", `This payout would take today's Sandbox payouts above US$${SANDBOX_PAYOUT_LIMITS.usdMinorPerDay / 100}, the daily limit for a business. It can be sent tomorrow.`);
}
