import { z } from "zod";
export interface EmailAdapter {
  send(input:{to:string;subject:string;text:string;html?:string;idempotencyKey:string}):Promise<{status:"ACCEPTED";messageId:string}|{status:"UNCONFIGURED"}>;
}
export class ResendEmail implements EmailAdapter {
  constructor(private key?:string,private from?:string,private fetchImpl:typeof fetch = fetch) {}
  async send(input:Parameters<EmailAdapter["send"]>[0]):ReturnType<EmailAdapter["send"]> {
    if (!this.key || !this.from) return {status:"UNCONFIGURED"};
    const response = await this.fetchImpl("https://api.resend.com/emails",{method:"POST",headers:{Authorization:`Bearer ${this.key}`,"Content-Type":"application/json","Idempotency-Key":input.idempotencyKey},body:JSON.stringify({from:this.from,to:[input.to],subject:input.subject,text:input.text,...(input.html ? {html:input.html} : {})}),signal:AbortSignal.timeout(10_000)});
    if (!response.ok) throw new Error("EMAIL_PROVIDER_REJECTED");
    const value = z.object({id:z.string().min(1)}).parse(await response.json());
    return {status:"ACCEPTED",messageId:value.id};
  }
}
export function getEmailAdapter():EmailAdapter { return new ResendEmail(process.env.RESEND_API_KEY,process.env.EMAIL_FROM); }
export function applicationOrigin() {
  const origin = new URL(process.env.APP_BASE_URL ?? "http://localhost:3000");
  if (process.env.NODE_ENV === "production" && origin.protocol !== "https:") throw new Error("HTTPS application origin required.");
  return origin.origin;
}
