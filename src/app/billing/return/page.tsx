import { redirect } from "next/navigation";
import { FairShiftBrand } from "@/app/components/product-shell";
import { AcquisitionProgress } from "@/app/components/acquisition-progress";
import { SubscriptionConfirmation } from "@/app/components/subscription-confirmation";
import { requireOwnerCustomer } from "@/server/auth/request";
import { ownerDestination } from "@/server/billing/entitlement";
import { getDatabase } from "@/server/db/client";
export const dynamic="force-dynamic";
// PayPal's return page answers at once. Rendering it reads only FairShift's stored subscription: it never
// calls PayPal, and never waits on the subscription's row lock, which PayPal's webhook can hold while it
// asks PayPal for the authoritative state. An Owner whose subscription FairShift has already confirmed
// goes straight on; otherwise the page appears now and its client asks for the status
// (checkSubscriptionStatusAction, polled), which reconciles with PayPal in the background.
export default async function BillingReturn() {
 const scope=await requireOwnerCustomer();
 const destination=await ownerDestination(getDatabase(),scope.organisationId);
 if (destination !== "/subscribe") redirect(destination);
 return <main className="acquisition-shell confirmation-shell"><FairShiftBrand /><AcquisitionProgress current="Plan"/><SubscriptionConfirmation/></main>;
}
