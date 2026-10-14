export const PAYPAL_CAPTURE_STATUSES = [
  "COMPLETED",
  "DECLINED",
  "PARTIALLY_REFUNDED",
  "PENDING",
  "REFUNDED",
  "FAILED",
] as const;

export type PayPalCaptureStatus = (typeof PAYPAL_CAPTURE_STATUSES)[number];
export type VerificationState = "PENDING" | "VERIFIED" | "FAILED";
export type ReconciliationState = "NOT_RECONCILED" | "PENDING" | "RECONCILED" | "ERROR";

export function mapCaptureStatus(status: PayPalCaptureStatus): {
  verificationState: VerificationState;
  reconciliationState: Exclude<ReconciliationState, "NOT_RECONCILED">;
} {
  if (status === "COMPLETED") {
    return { verificationState: "VERIFIED", reconciliationState: "RECONCILED" };
  }

  if (status === "PENDING") {
    return { verificationState: "PENDING", reconciliationState: "PENDING" };
  }

  return { verificationState: "FAILED", reconciliationState: "RECONCILED" };
}
