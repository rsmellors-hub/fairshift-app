import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Database, DatabaseSession } from "@/server/db/client";
import { auditEvents, businessPaypalConnections } from "@/server/db/schema";
import { UserFacingError } from "@/server/domain/errors";

// A business's own PayPal REST app (Owner decision, 11 Nov 2026). Payouts are sent from the business's
// account, never from FairShift's platform app; subscriptions stay on the platform app. The secret is sealed
// with AES-256-GCM under FAIRSHIFT_CREDENTIALS_KEY and bound to the business, so a sealed value copied to
// another business can't be opened. Only its last four characters are ever shown, and it is never logged.
// Sandbox only: the token test and every payout go to the PayPal Sandbox host.
export const PAYPAL_SANDBOX_API = "https://api-m.sandbox.paypal.com";
export const CREDENTIALS_KEY_ENV = "FAIRSHIFT_CREDENTIALS_KEY";

export function businessCredentialKey(value = process.env[CREDENTIALS_KEY_ENV]) {
  const key = Buffer.from(value ?? "", "base64");
  return key.length === 32 ? key : null;
}
const binding = (organisationId: string) => Buffer.from(`paypal:${organisationId}`);

export function sealSecret(secret: string, key: Buffer, organisationId: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(binding(organisationId));
  const body = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(".");
}
export function openSecret(sealed: string, key: Buffer, organisationId: string) {
  const [version, iv, tag, body] = sealed.split(".");
  if (version !== "v1" || !iv || !tag || !body) throw new Error("Unreadable sealed secret.");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAAD(binding(organisationId));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
}

// "Test connection": a client-credentials token from the Sandbox. Returns the app ID PayPal reports.
// The account's email isn't available to client credentials alone, so it is the Owner's declared sender.
export type TokenTest = (clientId: string, secret: string) => Promise<{ appId: string | null }>;
export const sandboxTokenTest: TokenTest = async (clientId, secret) => {
  const response = await fetch(`${PAYPAL_SANDBOX_API}/v1/oauth2/token`, { method: "POST", signal: AbortSignal.timeout(20_000),
    headers: { Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials" });
  if (!response.ok) throw new UserFacingError("paypal-connect-refused", "PayPal didn't accept that client ID and secret. Check them in your PayPal Developer Dashboard (Sandbox) and try again.");
  const data = z.object({ access_token: z.string().min(1), app_id: z.string().optional(), scope: z.string().optional() }).parse(await response.json());
  if (data.scope && !/payouts/i.test(data.scope)) throw new UserFacingError("paypal-connect-no-payouts", "This PayPal app can't send payouts. Turn on Payouts for the app in your PayPal Developer Dashboard.");
  return { appId: data.app_id ?? null };
};

const input = z.object({ clientId: z.string().trim().min(10).max(200), secret: z.string().trim().min(10).max(300), senderEmail: z.email().max(254) }).strict();

// Connects (or replaces) a business's PayPal app after a successful token test. Audited without the secret.
export async function connectBusinessPayPal(db: Database, actor: { organisationId: string; userId: string | null; role: string }, raw: unknown, test: TokenTest = sandboxTokenTest, now = new Date()) {
  if (actor.role !== "OWNER") throw new UserFacingError("paypal-connect-owner", "Only the business owner can connect PayPal.");
  const parsed = input.safeParse(raw);
  if (!parsed.success) throw new UserFacingError("paypal-connect-invalid", "Enter the Sandbox app's client ID and secret, and the PayPal account's email.");
  const key = businessCredentialKey();
  if (!key) throw new UserFacingError("paypal-connect-unavailable", "PayPal connections aren't available on this server yet.");
  const { appId } = await test(parsed.data.clientId, parsed.data.secret);
  return db.transaction(async tx => {
    await tx.update(businessPaypalConnections).set({ disconnectedAt: now }).where(and(eq(businessPaypalConnections.organisationId, actor.organisationId), isNull(businessPaypalConnections.disconnectedAt)));
    const [row] = await tx.insert(businessPaypalConnections).values({ id: randomUUID(), organisationId: actor.organisationId, clientId: parsed.data.clientId, secretSealed: sealSecret(parsed.data.secret, key, actor.organisationId),
      secretLast4: parsed.data.secret.slice(-4), appId, senderEmail: parsed.data.senderEmail.toLowerCase(), connectedBy: actor.userId, connectedAt: now, lastTestedAt: now }).returning();
    await tx.insert(auditEvents).values({ id: randomUUID(), organisationId: actor.organisationId, outletId: null, action: "PAYPAL_BUSINESS_CONNECTED", entityType: "business_paypal_connection", entityId: row.id,
      correlationId: `paypal-connection:${row.id}`, metadata: { actorUserId: actor.userId, actorRole: actor.role, appId, senderEmail: row.senderEmail, secretLast4: row.secretLast4 } });
    return { id: row.id, appId, senderEmail: row.senderEmail, secretLast4: row.secretLast4 };
  });
}

// What Business settings › Payouts shows: never the secret, only its last four characters.
export async function businessPayPalStatus(db: DatabaseSession, organisationId: string) {
  const [row] = await db.select({ id: businessPaypalConnections.id, appId: businessPaypalConnections.appId, senderEmail: businessPaypalConnections.senderEmail, secretLast4: businessPaypalConnections.secretLast4, clientIdTail: businessPaypalConnections.clientId, connectedAt: businessPaypalConnections.connectedAt, lastTestedAt: businessPaypalConnections.lastTestedAt })
    .from(businessPaypalConnections).where(and(eq(businessPaypalConnections.organisationId, organisationId), isNull(businessPaypalConnections.disconnectedAt)));
  return row ? { ...row, clientIdTail: row.clientIdTail.slice(-4) } : null;
}

// The credentials a payout for this business is sent with. Null when none is connected: the caller blocks the
// payout ("Connect your PayPal to pay your team") and never falls back to the platform credentials.
export async function businessPayoutCredentials(db: DatabaseSession, organisationId: string) {
  const key = businessCredentialKey();
  if (!key) return null;
  const [row] = await db.select().from(businessPaypalConnections).where(and(eq(businessPaypalConnections.organisationId, organisationId), isNull(businessPaypalConnections.disconnectedAt)));
  if (!row) return null;
  return { connectionId: row.id, clientId: row.clientId, secret: openSecret(row.secretSealed, key, organisationId), senderEmail: row.senderEmail, appId: row.appId };
}
