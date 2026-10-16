import { eq } from "drizzle-orm";
import type { Database } from "@/server/db/client";
import { organisations, subscriptions } from "@/server/db/schema";
export const personal = {title:"Ms",firstName:"Sam",surname:"Taylor",position:"Business owner",telephone:"+27111234567"} as const;
export const business = {businessAddress:"1 Business Road",city:"Johannesburg",province:"Gauteng",postalCode:"2000",country:"South Africa"};
export const locationAddress = {locationAddress:business.businessAddress,locationCity:business.city,locationProvince:business.province,locationPostalCode:business.postalCode,locationCountry:business.country};
export const setupFields = {...personal,...business,...locationAddress,sameAddress:"on"};
// Controlled provider fixture: never called from application or seed paths.
export async function entitled(db:Database, organisationId:string) {
 await db.update(organisations).set({setupCompletedAt:new Date()}).where(eq(organisations.id,organisationId));
 await db.update(subscriptions).set({status:"ACTIVE",verifiedAt:new Date(),providerId:`I-${organisationId.replaceAll("-","").toUpperCase()}`,planId:"P-TEST",tier:"MULTI_OUTLET",billingPeriod:"MONTHLY",locationLimit:5}).where(eq(subscriptions.organisationId,organisationId));
}

import { ensureCustomerOrganisation } from "@/server/auth/tenancy";
import { completeWorkplace } from "@/server/auth/onboarding";
// Build an entitled, completed workspace for operational regression fixtures.
export async function createOrganisation(db:Database,userId:string,input:Record<string,unknown>) {
 const member=await ensureCustomerOrganisation(db,userId);
 await entitled(db,member.organisationId);
 const location=await completeWorkplace(db,{userId,organisationId:member.organisationId,role:"OWNER"},{...personal,...input,...locationAddress,sameAddress:true});
 return {organisationId:member.organisationId,membershipId:member.id,locationId:location.id};
}
