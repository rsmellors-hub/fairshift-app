import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getDatabase } from "@/server/db/client";
import { dispatchPendingEmails } from "@/server/notifications/service";
import { getEmailAdapter } from "@/server/notifications/email";
export const runtime="nodejs";
export async function POST(request:Request) {
 const secret=process.env.NOTIFICATIONS_DISPATCH_SECRET;
 const header=request.headers.get("authorization") ?? "";
 const expected=Buffer.from(`Bearer ${secret ?? ""}`),received=Buffer.from(header);
 if (!secret || secret.length<32 || expected.length!==received.length || !timingSafeEqual(expected,received)) return NextResponse.json({error:"UNAUTHORIZED"},{status:401});
 try {await dispatchPendingEmails(getDatabase(),getEmailAdapter());return NextResponse.json({status:"DISPATCH_ATTEMPTED"});}
 catch {return NextResponse.json({error:"DISPATCH_UNAVAILABLE"},{status:503});}
}
