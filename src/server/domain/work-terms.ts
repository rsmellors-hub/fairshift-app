import { z } from "zod";

const minor = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const policyInput = z.discriminatedUnion("earningsModel", [
  z.object({ earningsModel: z.literal("HOURLY"), rateMinor: minor }),
  z.object({ earningsModel: z.literal("DAILY"), rateMinor: minor }),
  z.object({ earningsModel: z.literal("COMMISSION"), commissionBps: z.number().int().min(0).max(10000), commissionBasis: z.literal("VERIFIED_ATTRIBUTED_SALES") }),
]);
export type WorkPolicy = z.infer<typeof policyInput>;
function safe(value: bigint) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Amount exceeds the supported range.");
  return Number(value);
}
export function expectedWorkEarnings(input: WorkPolicy, startsAt: Date, endsAt: Date) {
  const policy = policyInput.parse(input);
  const duration = endsAt.getTime() - startsAt.getTime();
  if (!Number.isSafeInteger(duration) || duration <= 0) throw new Error("Invalid scheduled duration.");
  if (policy.earningsModel === "COMMISSION") return null;
  if (policy.earningsModel === "DAILY") return policy.rateMinor;
  const numerator = BigInt(policy.rateMinor) * BigInt(duration);
  // Do not silently choose a rounding rule for fractional cents.
  if (numerator % 3600000n !== 0n) throw new Error("Scheduled hourly earnings must resolve to whole cents.");
  return safe(numerator / 3600000n);
}
export function commissionEarnings(salesMinor: number | null, bps: number, verification: string) {
  z.number().int().min(0).max(10000).parse(bps);
  if (salesMinor === null || verification !== "VERIFIED") return { state: "AWAITING_VERIFIED_ATTRIBUTION", amountMinor: null };
  minor.parse(salesMinor);
  const numerator = BigInt(salesMinor) * BigInt(bps);
  if (numerator % 10000n) return { state: "ROUNDING_POLICY_REQUIRED", amountMinor: null };
  return { state: "CALCULATED", amountMinor: safe(numerator / 10000n) };
}
