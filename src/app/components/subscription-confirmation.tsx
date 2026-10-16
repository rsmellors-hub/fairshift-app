"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { checkSubscriptionStatusAction } from "@/app/auth-actions";
import { startConfirmationPolling } from "@/lib/confirmation";

const recoveryMessage = "We couldn’t confirm your subscription yet. Check the payment status or try again shortly.";
export function SubscriptionConfirmation() {
  const router = useRouter();
  const [recovery, setRecovery] = useState(false);
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState("");
  const inFlight = useRef(false);

  const check = useCallback(async (showMessage = false) => {
    if (inFlight.current) return false;
    inFlight.current = true; setChecking(true); setMessage("");
    try {
      const result = await checkSubscriptionStatusAction();
      if (result.destination) {router.replace(result.destination); return true;}
      if (showMessage) setMessage(result.message ?? recoveryMessage);
    } catch {if (showMessage) setMessage(recoveryMessage);}
    finally {inFlight.current = false; setChecking(false);}
    return false;
  }, [router]);
  useEffect(() => startConfirmationPolling(() => check(), () => setRecovery(true), () => setMessage(recoveryMessage)), [check]);
  return <section className="confirmation-content">
    <div className="confirmation-mark" aria-hidden="true">⋯</div>
    <h1>Setting up your FairShift account</h1>
    <p>Your subscription has been approved. We’re confirming the details with PayPal. This normally takes a few seconds.</p>
    <p className="confirmation-status" role="status">{message || (checking ? "Checking your payment status…" : "Preparing your account…")}</p>
    {recovery ? <button type="button" className="secondary-button" disabled={checking} onClick={() => void check(true)}>{checking ? "Checking payment status…" : "Check payment status"}</button> : null}
  </section>;
}
