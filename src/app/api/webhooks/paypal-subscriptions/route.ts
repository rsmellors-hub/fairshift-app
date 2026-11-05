import { assertSandboxDeployment, SandboxIsolationError } from "@/server/config/deployment";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { getDatabase } from "@/server/db/client";
import { getSubscriptionAdapter } from "@/server/billing/paypal";
import { processSubscriptionWebhook } from "@/server/billing/service";
import { WebhookError } from "@/server/integrations/paypal/webhook";
export const runtime="nodejs";
export async function POST(request:Request) {
 try { assertSandboxDeployment(); }
 catch (error) { if (error instanceof SandboxIsolationError) return NextResponse.json({error:error.code},{status:error.status}); throw error; }
 const adapter=getSubscriptionAdapter();
 if (!adapter) return NextResponse.json({error:"SUBSCRIPTIONS_UNCONFIGURED"},{status:503});
 const body=await request.text();
 if (body.length>256_000) return NextResponse.json({error:"EVENT_TOO_LARGE"},{status:413});
 try {return NextResponse.json(await processSubscriptionWebhook(getDatabase(),adapter,body,request.headers));}
 catch (error) {return NextResponse.json({error:error instanceof SandboxIsolationError ? error.code : error instanceof WebhookError ? error.code : "VERIFICATION_UNAVAILABLE"},{status:error instanceof SandboxIsolationError ? error.status : error instanceof WebhookError ? error.status : error instanceof ZodError ? 400 : 503});}
}
