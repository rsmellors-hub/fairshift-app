"use client";

import Link from "next/link";
import { useState } from "react";

type Transaction = {
  internalReference: string;
  paypalOrderId: string | null;
  paypalCaptureId: string | null;
  currencyCode: string;
  grossAmountMinor: number;
  providerStatus: string;
  reconciliationState: string;
  verificationState: string;
  reconciledAt: string | null;
};

export function CaptureOrder({ orderId }: { orderId: string }) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [transaction, setTransaction] = useState<Transaction | null>(null);

  async function capture() {
    setWorking(true);
    setError("");
    try {
      const response = await fetch(`/api/paypal/orders/${encodeURIComponent(orderId)}/capture`, {
        method: "POST",
      });
      const body = (await response.json()) as { transaction?: Transaction; error?: string };
      if (!response.ok || !body.transaction) throw new Error(body.error ?? "CAPTURE_FAILED");
      setTransaction(body.transaction);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "CAPTURE_FAILED");
    } finally {
      setWorking(false);
    }
  }

  if (transaction) {
    return (
      <div className="result-card">
        <span className={`status ${transaction.verificationState.toLowerCase()}`}>
          {transaction.verificationState}
        </span>
        <h2>Capture reconciled</h2>
        <dl className="evidence-list">
          <div><dt>FairShift reference</dt><dd>{transaction.internalReference}</dd></div>
          <div><dt>PayPal order</dt><dd>{transaction.paypalOrderId}</dd></div>
          <div><dt>PayPal capture</dt><dd>{transaction.paypalCaptureId}</dd></div>
          <div><dt>Amount</dt><dd>{transaction.currencyCode} {(transaction.grossAmountMinor / 100).toFixed(2)}</dd></div>
          <div><dt>Provider status</dt><dd>{transaction.providerStatus}</dd></div>
          <div><dt>Reconciliation</dt><dd>{transaction.reconciliationState}</dd></div>
        </dl>
        <Link className="text-link" href="/">View transaction evidence →</Link>
      </div>
    );
  }

  return (
    <div className="result-card">
      <span className="status pending">SANDBOX · PENDING</span>
      <h2>Buyer approval returned</h2>
      <p>Capture this approved PayPal order on the server, then reconcile the capture through Payments v2.</p>
      <code>{orderId}</code>
      <button className="primary-button" disabled={working} onClick={capture}>
        {working ? "Capturing and reconciling…" : "Capture approved sandbox order"}
      </button>
      {error && <p className="error-text">Capture failed: {error}</p>}
    </div>
  );
}
