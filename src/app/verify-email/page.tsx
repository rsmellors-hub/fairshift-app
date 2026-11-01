import type { Metadata } from "next";
import { AcquisitionProgress } from "@/app/components/acquisition-progress";
import { AuthShell } from "@/app/components/auth-shell";
import { SecureLinkForm } from "@/app/components/secure-link-form";
import { verifyEmailAction } from "@/app/auth-actions";

export const metadata: Metadata = { title: "Verify your email" };

export default async function VerifyEmail({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const failed = (await searchParams).status === "error";
  return <AuthShell title="Verify your email" progress={<AcquisitionProgress current="Verify" />}>
    {failed ? <p className="form-alert" role="alert">That link has expired or was already used. <a href="/check-email">Send a new one</a>.</p> : <p>Confirm this is your email address to continue setting up FairShift.</p>}
    {failed ? null : <SecureLinkForm action={verifyEmailAction} kind="verify" />}
  </AuthShell>;
}
