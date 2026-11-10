import type { Metadata } from "next";
import Link from "next/link";
import { AuthShell } from "@/app/components/auth-shell";
import { SecureLinkForm } from "@/app/components/secure-link-form";
import { confirmPayoutEmailAction } from "@/app/worker-actions";

export const metadata: Metadata = { title: "Confirm your PayPal email" };

// The link emailed to a worker's new PayPal address. Its code is in the fragment, so it never reaches a
// server log; the worker presses Confirm to use it. Until then FairShift sends them no new payouts.
export default async function ConfirmPayoutEmail({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const status = (await searchParams).status;
  return <AuthShell title="Confirm your PayPal email">
    {status === "done" ? <p role="status">Confirmed. FairShift pays your future shifts to this PayPal email, and payouts have resumed. <Link href="/worker/profile#payment-settings">Back to your profile</Link></p>
      : status === "error" ? <p className="form-alert" role="alert">That link has expired or was already used. Nothing changed. You can ask for a new one from your Profile.</p>
      : <><p>Confirm this address for your FairShift pay. Until you do, FairShift won’t send you new payouts.</p><SecureLinkForm action={confirmPayoutEmailAction} kind="payout-email" /></>}
  </AuthShell>;
}
