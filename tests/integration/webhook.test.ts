import { count, eq, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import {
  attachPayPalCapture,
  attachPayPalOrder,
  createPendingSale,
  getSaleByCaptureId,
} from "@/server/db/repository";
import { auditEvents, providerEvents, saleTransactions } from "@/server/db/schema";
import { PayPalApiError } from "@/server/integrations/paypal/client";
import {
  processPayPalWebhook,
  readPayPalTransmissionHeaders,
} from "@/server/integrations/paypal/webhook";
import { createTestDatabase } from "../helpers/database";
import {
  captureWebhook,
  createFakePayPalAdapter,
  paypalHeaders,
} from "../helpers/paypal";

async function seedCapturedSale(db: Parameters<typeof createPendingSale>[0]) {
  const sale = await createPendingSale(db, {
    id: "40000000-0000-4000-8000-000000000001",
    internalReference: "FS-test",
    currencyCode: "USD",
    grossAmountMinor: 500,
  });
  await attachPayPalOrder(db, sale.id, "ORDER123456", "CREATED");
  await attachPayPalCapture(db, sale.id, { captureId: "CAPTURE123456", status: "COMPLETED" });
  return sale;
}

describe("PayPal webhook inbox", () => {
  it("retries an unfinished event after a transient capture retrieval failure", async () => {
    const testDb = await createTestDatabase();
    try {
      await seedCapturedSale(testDb.db);
      const base = createFakePayPalAdapter();
      const getCapture = vi.fn(base.getCapture)
        .mockRejectedValueOnce(new PayPalApiError("Test timeout", "TIMEOUT"));
      const verifyWebhookSignature = vi.fn(base.verifyWebhookSignature);
      const paypal = createFakePayPalAdapter({ getCapture, verifyWebhookSignature });
      const input = { db: testDb.db, paypal, rawBody: captureWebhook(), headers: paypalHeaders() };

      await expect(processPayPalWebhook(input)).rejects.toMatchObject({ code: "TIMEOUT" });
      const [unfinished] = await testDb.db.select().from(providerEvents);
      expect(unfinished).toMatchObject({ processingState: "RECEIVED", processedAt: null });
      expect((await getSaleByCaptureId(testDb.db, "CAPTURE123456"))?.verificationState).toBe("PENDING");

      await expect(processPayPalWebhook(input)).resolves.toMatchObject({
        status: "PROCESSED", duplicate: true, httpStatus: 200,
      });
      const recoveredSale = await getSaleByCaptureId(testDb.db, "CAPTURE123456");
      expect(recoveredSale?.verificationState).toBe("VERIFIED");
      const events = await testDb.db.select().from(providerEvents);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ processingState: "PROCESSED", saleTransactionId: recoveredSale?.id });
      expect(events[0].processedAt).not.toBeNull();

      await expect(processPayPalWebhook(input)).resolves.toMatchObject({ status: "PROCESSED", duplicate: true });
      expect(getCapture).toHaveBeenCalledTimes(2);
      expect(verifyWebhookSignature).toHaveBeenCalledTimes(3);
      expect(await getSaleByCaptureId(testDb.db, "CAPTURE123456")).toEqual(recoveredSale);
      expect(await testDb.db.select().from(saleTransactions)).toHaveLength(1);
      const verifiedAudits = await testDb.db.select().from(auditEvents)
        .where(eq(auditEvents.action, "PAYPAL_CAPTURE_VERIFIED"));
      expect(verifiedAudits).toHaveLength(1);
    } finally {
      await testDb.close();
    }
  });

  it("rejects missing verification headers", () => {
    expect(() => readPayPalTransmissionHeaders(new Headers())).toThrow();
  });

  it.each([
    new PayPalApiError("Test network failure", "NETWORK_ERROR"),
    new PayPalApiError("Test upstream failure", "PAYPAL_HTTP_ERROR", 503),
    new Error("Test transient retrieval failure"),
  ])("remains recoverable through repeated failures: %s", async (failure) => {
    const testDb = await createTestDatabase();
    try {
      await seedCapturedSale(testDb.db);
      const getCapture = vi.fn(createFakePayPalAdapter().getCapture)
        .mockRejectedValueOnce(failure).mockRejectedValueOnce(failure);
      const input = { db: testDb.db, paypal: createFakePayPalAdapter({ getCapture }), rawBody: captureWebhook(), headers: paypalHeaders() };
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(processPayPalWebhook(input)).rejects.toThrow(failure);
        expect((await getSaleByCaptureId(testDb.db, "CAPTURE123456"))?.verificationState).toBe("PENDING");
        const events = await testDb.db.select().from(providerEvents);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ processingState: "RECEIVED", processedAt: null });
      }
      await expect(processPayPalWebhook(input)).resolves.toMatchObject({ status: "PROCESSED", duplicate: true });
      expect(getCapture).toHaveBeenCalledTimes(3);
      expect((await getSaleByCaptureId(testDb.db, "CAPTURE123456"))?.verificationState).toBe("VERIFIED");
    } finally {
      await testDb.close();
    }
  });

  it("rolls back sale, audits and completion together if processing fails after reconciliation", async () => {
    const testDb = await createTestDatabase();
    try {
      await seedCapturedSale(testDb.db);
      // Fail after reconciliation and the event-state update to exercise the
      // crash window that a state-only retry check cannot safely handle.
      await testDb.db.execute(sql`
        CREATE FUNCTION reject_webhook_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.action = 'PAYPAL_WEBHOOK_PROCESSED' THEN
            RAISE EXCEPTION 'Injected audit persistence failure';
          END IF;
          RETURN NEW;
        END $$;
      `);
      await testDb.db.execute(sql`
        CREATE TRIGGER reject_webhook_audit BEFORE INSERT ON audit_events
        FOR EACH ROW EXECUTE FUNCTION reject_webhook_audit();
      `);
      const input = { db: testDb.db, paypal: createFakePayPalAdapter(), rawBody: captureWebhook(), headers: paypalHeaders() };
      const before = await getSaleByCaptureId(testDb.db, "CAPTURE123456");
      await expect(processPayPalWebhook(input)).rejects.toThrow();
      expect(await getSaleByCaptureId(testDb.db, "CAPTURE123456")).toEqual(before);
      expect(await testDb.db.select().from(auditEvents)).toHaveLength(0);
      const [unfinished] = await testDb.db.select().from(providerEvents);
      expect(unfinished).toMatchObject({ processingState: "RECEIVED", processedAt: null, saleTransactionId: null });

      await testDb.db.execute(sql`DROP TRIGGER reject_webhook_audit ON audit_events`);
      await expect(processPayPalWebhook(input)).resolves.toMatchObject({ status: "PROCESSED", duplicate: true });
      expect((await getSaleByCaptureId(testDb.db, "CAPTURE123456"))?.verificationState).toBe("VERIFIED");
      expect(await testDb.db.select().from(auditEvents)
        .where(eq(auditEvents.action, "PAYPAL_CAPTURE_VERIFIED"))).toHaveLength(1);
    } finally {
      await testDb.close();
    }
  });

  it("serializes overlapping deliveries without duplicate reconciliation or evidence", async () => {
    const testDb = await createTestDatabase();
    try {
      await seedCapturedSale(testDb.db);
      const getCapture = vi.fn(createFakePayPalAdapter().getCapture);
      const input = { db: testDb.db, paypal: createFakePayPalAdapter({ getCapture }), rawBody: captureWebhook(), headers: paypalHeaders() };
      const results = await Promise.all([processPayPalWebhook(input), processPayPalWebhook(input)]);
      expect(results.every((result) => result.status === "PROCESSED" && result.httpStatus === 200)).toBe(true);
      expect(getCapture).toHaveBeenCalledTimes(1);
      expect(await testDb.db.select().from(providerEvents)).toHaveLength(1);
      expect(await testDb.db.select().from(saleTransactions)).toHaveLength(1);
      expect(await testDb.db.select().from(auditEvents)
        .where(eq(auditEvents.action, "PAYPAL_CAPTURE_VERIFIED"))).toHaveLength(1);
      expect(await testDb.db.select().from(auditEvents)
        .where(eq(auditEvents.action, "PAYPAL_WEBHOOK_PROCESSED"))).toHaveLength(1);
    } finally {
      await testDb.close();
    }
  });

  it.each(["amount", "currency", "order"] as const)("does not verify mismatched %s evidence on recovery", async (field) => {
    const testDb = await createTestDatabase();
    try {
      await seedCapturedSale(testDb.db);
      const capture = await createFakePayPalAdapter().getCapture("CAPTURE123456");
      if (field === "amount") capture.amount.value = "6.00";
      if (field === "currency") capture.amount.currency_code = "EUR";
      if (field === "order") capture.supplementary_data = { related_ids: { order_id: "OTHER-ORDER" } };
      const getCapture = vi.fn(async () => capture)
        .mockRejectedValueOnce(new PayPalApiError("Test timeout", "TIMEOUT"));
      const input = { db: testDb.db, paypal: createFakePayPalAdapter({ getCapture }), rawBody: captureWebhook(), headers: paypalHeaders() };
      await expect(processPayPalWebhook(input)).rejects.toMatchObject({ code: "TIMEOUT" });
      await expect(processPayPalWebhook(input)).resolves.toMatchObject({ status: "PROCESSED" });
      const sale = await getSaleByCaptureId(testDb.db, "CAPTURE123456");
      expect(sale).toMatchObject({ verificationState: "FAILED", reconciliationState: "ERROR", failureCode: "RECONCILIATION_EVIDENCE_MISMATCH" });
      await processPayPalWebhook(input);
      expect(getCapture).toHaveBeenCalledTimes(2);
      expect(await testDb.db.select().from(auditEvents)
        .where(eq(auditEvents.action, "PAYPAL_CAPTURE_VERIFIED"))).toHaveLength(0);
    } finally {
      await testDb.close();
    }
  });

  it("rejects malformed JSON without verification, persistence or reconciliation", async () => {
    const testDb = await createTestDatabase();
    try {
      const verifyWebhookSignature = vi.fn();
      const getCapture = vi.fn();
      await expect(processPayPalWebhook({ db: testDb.db, paypal: createFakePayPalAdapter({ verifyWebhookSignature, getCapture }), rawBody: "{", headers: paypalHeaders() }))
        .rejects.toMatchObject({ code: "INVALID_JSON", status: 400 });
      expect(verifyWebhookSignature).not.toHaveBeenCalled();
      expect(getCapture).not.toHaveBeenCalled();
      expect(await testDb.db.select().from(providerEvents)).toHaveLength(0);
    } finally {
      await testDb.close();
    }
  });

  it("rejects failed verification before persisting financial evidence", async () => {
    const testDb = await createTestDatabase();
    try {
      const paypal = createFakePayPalAdapter({ async verifyWebhookSignature() { return false; } });
      await expect(
        processPayPalWebhook({ db: testDb.db, paypal, rawBody: captureWebhook(), headers: paypalHeaders() }),
      ).rejects.toMatchObject({ code: "SIGNATURE_VERIFICATION_FAILED", status: 401 });
      const [result] = await testDb.db.select({ value: count() }).from(providerEvents);
      expect(result.value).toBe(0);
    } finally {
      await testDb.close();
    }
  });

  it("persists a verified event and reconciles the matching sale", async () => {
    const testDb = await createTestDatabase();
    try {
      await seedCapturedSale(testDb.db);
      const result = await processPayPalWebhook({
        db: testDb.db,
        paypal: createFakePayPalAdapter(),
        rawBody: captureWebhook(),
        headers: paypalHeaders(),
      });
      expect(result).toMatchObject({ status: "PROCESSED", duplicate: false, httpStatus: 200 });
      expect((await getSaleByCaptureId(testDb.db, "CAPTURE123456"))?.verificationState).toBe("VERIFIED");
    } finally {
      await testDb.close();
    }
  });

  it("deduplicates a repeated provider event", async () => {
    const testDb = await createTestDatabase();
    try {
      await seedCapturedSale(testDb.db);
      const base = createFakePayPalAdapter();
      const getCapture = vi.fn(base.getCapture);
      const paypal = createFakePayPalAdapter({ getCapture });
      await processPayPalWebhook({ db: testDb.db, paypal, rawBody: captureWebhook(), headers: paypalHeaders() });
      const duplicate = await processPayPalWebhook({ db: testDb.db, paypal, rawBody: captureWebhook(), headers: paypalHeaders() });
      expect(duplicate).toMatchObject({ duplicate: true, status: "PROCESSED" });
      expect(getCapture).toHaveBeenCalledTimes(1);
      const [result] = await testDb.db.select({ value: count() }).from(providerEvents);
      expect(result.value).toBe(1);
    } finally {
      await testDb.close();
    }
  });

  it("records an unknown verified event as ignored", async () => {
    const testDb = await createTestDatabase();
    try {
      const rawBody = JSON.stringify({
        id: "WH-UNKNOWN",
        event_type: "CHECKOUT.ORDER.APPROVED",
        create_time: "2026-10-14T10:00:02.000Z",
        resource: { id: "ORDER123456" },
      });
      const getCapture = vi.fn();
      const input = {
        db: testDb.db,
        paypal: createFakePayPalAdapter({ getCapture }),
        rawBody,
        headers: paypalHeaders(),
      };
      const result = await processPayPalWebhook(input);
      expect(result.status).toBe("IGNORED");
      await expect(processPayPalWebhook(input)).resolves.toMatchObject({ status: "IGNORED", duplicate: true, httpStatus: 200 });
      expect(getCapture).not.toHaveBeenCalled();
      expect(await testDb.db.select().from(providerEvents)).toHaveLength(1);
      expect(await testDb.db.select().from(auditEvents)).toHaveLength(1);
      const [event] = await testDb.db
        .select()
        .from(providerEvents)
        .where(eq(providerEvents.providerEventId, "WH-UNKNOWN"));
      expect(event.processingState).toBe("IGNORED");
    } finally {
      await testDb.close();
    }
  });

  it("quarantines a verified but unmatched capture event", async () => {
    const testDb = await createTestDatabase();
    try {
      const paypal = createFakePayPalAdapter({
        getCapture: vi.fn(async () => ({
          id: "CAPTURE123456",
          status: "COMPLETED" as const,
          amount: { currency_code: "USD", value: "5.00" },
          supplementary_data: { related_ids: { order_id: "ORDER-NOT-FOUND" } },
        })),
      });
      const result = await processPayPalWebhook({
        db: testDb.db,
        paypal,
        rawBody: captureWebhook(),
        headers: paypalHeaders(),
      });
      expect(result).toMatchObject({ status: "UNMATCHED", httpStatus: 202 });
      const [event] = await testDb.db.select().from(providerEvents);
      expect(event.processingState).toBe("UNMATCHED");
      expect(event.saleTransactionId).toBeNull();
      await expect(processPayPalWebhook({ db: testDb.db, paypal, rawBody: captureWebhook(), headers: paypalHeaders() }))
        .resolves.toMatchObject({ status: "UNMATCHED", duplicate: true, httpStatus: 202 });
      expect(paypal.getCapture).toHaveBeenCalledTimes(1);
      expect(await testDb.db.select().from(providerEvents)).toHaveLength(1);
      expect(await testDb.db.select().from(saleTransactions)).toHaveLength(0);
    } finally {
      await testDb.close();
    }
  });
});
