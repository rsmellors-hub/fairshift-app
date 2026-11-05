import { sandboxFixture } from "../helpers/sandbox";
import { beforeEach as beforeSandbox, afterEach as afterSandbox, vi as sandboxVi } from "vitest";
beforeSandbox(() => sandboxFixture());
afterSandbox(() => sandboxVi.unstubAllEnvs());
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/webhooks/paypal/route";
import { getDatabase } from "@/server/db/client";
import { attachPayPalOrder, createPendingSale, getSaleByOrderId } from "@/server/db/repository";
import { auditEvents, providerEvents } from "@/server/db/schema";
import { PayPalApiError } from "@/server/integrations/paypal/client";
import { getPayPalClient } from "@/server/integrations/paypal/factory";
import { createTestDatabase } from "../helpers/database";
import { captureWebhook, createFakePayPalAdapter, paypalHeaders } from "../helpers/paypal";

vi.mock("@/server/db/client", () => ({ getDatabase: vi.fn() }));
vi.mock("@/server/integrations/paypal/factory", () => ({ getPayPalClient: vi.fn() }));

function request() {
  return new Request("http://localhost/api/webhooks/paypal", {
    method: "POST", headers: paypalHeaders(), body: captureWebhook(),
  });
}

afterEach(() => vi.resetAllMocks());

describe("webhook HTTP recovery", () => {
  it.each([
    { failure: new PayPalApiError("Test timeout", "TIMEOUT"), status: 503 },
    { failure: new PayPalApiError("Test network failure", "NETWORK_ERROR"), status: 503 },
    { failure: new PayPalApiError("Test provider 5xx", "PAYPAL_HTTP_ERROR", 500), status: 503 },
    { failure: new Error("Test transient failure"), status: 500 },
  ])("returns $status on failure and 200 only after redelivery completes: $failure", async ({ failure, status }) => {
    const testDb = await createTestDatabase();
    try {
      vi.mocked(getDatabase).mockReturnValue(testDb.db);
      const sale = await createPendingSale(testDb.db, {
        id: "40000000-0000-4000-8000-000000000001", internalReference: "FS-test",
        currencyCode: "USD", grossAmountMinor: 500,
      });
      await attachPayPalOrder(testDb.db, sale.id, "ORDER123456", "CREATED");
      const getCapture = vi.fn(createFakePayPalAdapter().getCapture).mockRejectedValueOnce(failure);
      vi.mocked(getPayPalClient).mockReturnValue(createFakePayPalAdapter({ getCapture }) as ReturnType<typeof getPayPalClient>);

      const failed = await POST(request());
      expect(failed.status).toBe(status);
      expect(await failed.json()).toEqual({ error: status === 503 ? "PAYPAL_VERIFICATION_UNAVAILABLE" : "WEBHOOK_PROCESSING_FAILED" });
      expect((await getSaleByOrderId(testDb.db, "ORDER123456"))?.verificationState).toBe("PENDING");
      const [unfinished] = await testDb.db.select().from(providerEvents);
      expect(unfinished).toMatchObject({ processingState: "RECEIVED", processedAt: null });

      const recovered = await POST(request());
      expect(recovered.status).toBe(200);
      expect(await recovered.json()).toEqual({ status: "PROCESSED", duplicate: true });
      expect((await getSaleByOrderId(testDb.db, "ORDER123456"))?.verificationState).toBe("VERIFIED");
      const duplicate = await POST(request());
      expect(duplicate.status).toBe(200);
      expect(getCapture).toHaveBeenCalledTimes(2);
      expect(await testDb.db.select().from(providerEvents)).toHaveLength(1);
      expect(await testDb.db.select().from(auditEvents)
        .where(eq(auditEvents.action, "PAYPAL_CAPTURE_VERIFIED"))).toHaveLength(1);
    } finally {
      await testDb.close();
    }
  });

  it("rejects invalid signatures before retrieving a capture or writing evidence", async () => {
    const testDb = await createTestDatabase();
    try {
      vi.mocked(getDatabase).mockReturnValue(testDb.db);
      const getCapture = vi.fn();
      vi.mocked(getPayPalClient).mockReturnValue(createFakePayPalAdapter({
        getCapture, async verifyWebhookSignature() { return false; },
      }) as ReturnType<typeof getPayPalClient>);
      const response = await POST(request());
      expect(response.status).toBe(401);
      expect(getCapture).not.toHaveBeenCalled();
      expect(await testDb.db.select().from(providerEvents)).toHaveLength(0);
      expect(await testDb.db.select().from(auditEvents)).toHaveLength(0);
    } finally {
      await testDb.close();
    }
  });
});
