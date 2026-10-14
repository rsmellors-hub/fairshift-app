import { describe, expect, it } from "vitest";

import { mapCaptureStatus } from "@/server/domain/payment-status";

describe("PayPal capture status mapping", () => {
  it("verifies only a reconciled completed capture", () => {
    expect(mapCaptureStatus("COMPLETED")).toEqual({
      verificationState: "VERIFIED",
      reconciliationState: "RECONCILED",
    });
  });

  it("keeps pending captures unverified", () => {
    expect(mapCaptureStatus("PENDING")).toEqual({
      verificationState: "PENDING",
      reconciliationState: "PENDING",
    });
  });

  it.each(["DECLINED", "FAILED", "REFUNDED", "PARTIALLY_REFUNDED"] as const)(
    "does not verify %s captures",
    (status) => expect(mapCaptureStatus(status).verificationState).toBe("FAILED"),
  );
});
