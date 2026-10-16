import { redirect } from "next/navigation";
import { checkSubscriptionStatusAction } from "@/app/auth-actions";
import { AcquisitionProgress } from "@/app/components/acquisition-progress";
import { SubscriptionConfirmation } from "@/app/components/subscription-confirmation";
export const dynamic="force-dynamic";
export default async function BillingReturn() {
 const result=await checkSubscriptionStatusAction();
 if (result.destination) redirect(result.destination);
 return <main className="acquisition-shell confirmation-shell"><div className="acquisition-brand">FairShift</div><AcquisitionProgress current="Plan"/><SubscriptionConfirmation/></main>;
}
