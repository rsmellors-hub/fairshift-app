"use client";

import { useState } from "react";

export function CreateSaleButton({ enabled }: { enabled: boolean }) {
  const [state, setState] = useState<"idle" | "working" | "error">("idle");
  const [message, setMessage] = useState("");

  async function createSale() {
    setState("working");
    setMessage("");
    try {
      const response = await fetch("/api/paypal/orders", { method: "POST" });
      const body = (await response.json()) as { approvalUrl?: string; error?: string };
      if (!response.ok || !body.approvalUrl) {
        throw new Error(body.error ?? "ORDER_CREATE_FAILED");
      }
      window.location.assign(body.approvalUrl);
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "ORDER_CREATE_FAILED");
    }
  }

  return (
    <div className="action-area">
      <button className="primary-button" disabled={!enabled || state === "working"} onClick={createSale}>
        {state === "working" ? "Creating sandbox order…" : "Create PayPal sandbox sale"}
      </button>
      {!enabled && <p className="action-note">Configure PostgreSQL and PayPal sandbox variables first.</p>}
      {state === "error" && <p className="error-text">Order was not created: {message}</p>}
    </div>
  );
}
