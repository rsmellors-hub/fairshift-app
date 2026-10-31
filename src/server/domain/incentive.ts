import { z } from "zod";

// The MVP incentive: a fixed bonus if the worker's own attributed sales value for the
// shift meets or exceeds the target accepted with the shift's terms; otherwise nothing.
export const INDIVIDUAL_INCENTIVE_BASIS = "INDIVIDUAL_ATTRIBUTED_SALES";

const minor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export function calculateIncentive(performanceSalesMinor: number, targetSalesMinor: number, configuredAmountMinor: number) {
  minor.parse(performanceSalesMinor);
  minor.parse(targetSalesMinor);
  minor.parse(configuredAmountMinor);
  const earned = performanceSalesMinor >= targetSalesMinor;
  return { earned, earnedAmountMinor: earned ? configuredAmountMinor : 0, status: earned ? "EARNED" as const : "NOT_EARNED" as const };
}

const positive = minor.positive();
const incentiveTerms = z.object({
  incentiveBasis: z.literal(INDIVIDUAL_INCENTIVE_BASIS), incentiveTargetMinor: positive, incentiveAmountMinor: positive,
  currencyCode: z.string().regex(/^[A-Z]{3}$/), startsAt: z.iso.datetime(), endsAt: z.iso.datetime(),
});

// The incentive terms of an immutable acceptance snapshot, or null when none was accepted:
// earlier snapshots and the seeded demo's team incentive have no basis, and stay base-only.
export function acceptedIncentiveTerms(snapshot: unknown) {
  if (typeof snapshot !== "object" || snapshot === null || (snapshot as { incentiveBasis?: unknown }).incentiveBasis == null) return null;
  const terms = incentiveTerms.parse(snapshot);
  return { targetMinor: terms.incentiveTargetMinor, bonusMinor: terms.incentiveAmountMinor, currencyCode: terms.currencyCode, startsAt: new Date(terms.startsAt), endsAt: new Date(terms.endsAt) };
}
