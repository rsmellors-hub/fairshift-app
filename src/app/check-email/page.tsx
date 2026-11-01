import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";
import { requestVerificationAction, signOutAction } from "@/app/auth-actions";
import { AcquisitionProgress } from "@/app/components/acquisition-progress";
import { AuthShell } from "@/app/components/auth-shell";
import { maskedEmail } from "@/app/components/format";
import { requireIdentity } from "@/server/auth/request";
import { getDatabase } from "@/server/db/client";
import { notificationDeliveries, notifications } from "@/server/db/schema";

export const metadata: Metadata = { title: "Check your email" };
export const dynamic = "force-dynamic";

// The verification email is sent when the account is created, so this page has one job:
// say where to look. It claims "sent" only when the email service took the message.
export default async function CheckEmail({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { user } = await requireIdentity();
  if (user.emailVerifiedAt) redirect("/account");
  const { status } = await searchParams;
  const [latest] = await getDatabase().select({ status: notificationDeliveries.status }).from(notifications)
    .innerJoin(notificationDeliveries, eq(notificationDeliveries.notificationId, notifications.id))
    .where(and(eq(notifications.userId, user.id), eq(notifications.kind, "VERIFY_EMAIL")))
    .orderBy(desc(notifications.createdAt)).limit(1);
  const sent = latest?.status === "ACCEPTED";
  return <AuthShell title="Check your email" progress={<AcquisitionProgress current="Verify" />}>
    {sent
      ? <p>We sent a verification link to <strong>{maskedEmail(user.email)}</strong>. Open the link to verify your account and continue setting up FairShift.</p>
      : <p>We couldn’t send a verification link to <strong>{maskedEmail(user.email)}</strong> just now. Your account is saved. Try sending it again.</p>}
    {status === "sent" && sent ? <p className="form-notice" role="status">Verification email sent again.</p> : null}
    {status === "limited" ? <p className="form-alert" role="alert">Too many emails requested. Wait a little while and try again.</p> : null}
    <form action={requestVerificationAction}><button className={sent ? "secondary-button" : "primary-button"}>{sent ? "Resend verification email" : "Send verification email"}</button></form>
    <p className="auth-switch">The link expires after an hour. Check your spam folder if it hasn’t arrived.</p>
    <p className="auth-switch">Joining a team? <a href="/invite">Go back to your invitation</a>.</p>
    <form action={signOutAction}><button className="link-button">Use a different email: sign out</button></form>
  </AuthShell>;
}
