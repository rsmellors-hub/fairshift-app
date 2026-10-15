import { eq } from "drizzle-orm";
import type { Database } from "@/server/db/client";
import { subscriptions } from "@/server/db/schema";
export const personal = {title:"Ms",firstName:"Sam",surname:"Taylor",position:"Business owner",telephone:"+27111234567"};
export const business = {businessAddress:"1 Business Road",city:"Johannesburg",province:"Gauteng",postalCode:"2000",country:"South Africa"};
// Controlled provider fixture: never called from application or seed paths.
export async function entitled(db:Database, organisationId:string) {
 await db.update(subscriptions).set({status:"ACTIVE",verifiedAt:new Date(),providerId:`I-${organisationId.replaceAll("-","").toUpperCase()}`,planId:"P-TEST"}).where(eq(subscriptions.organisationId,organisationId));
}
