import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";

// Merchant credentials at rest: AES-256-GCM under a server-held key, bound to the
// organisation and location they belong to, so a sealed value copied to another row
// cannot be opened. Without a valid key nothing can be connected or synchronised.
const keySchema = z.string().transform((value, context) => {
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) { context.addIssue({ code: "custom", message: "Key must be 32 bytes, base64 encoded." }); return z.NEVER; }
  return key;
});
export function credentialKey(value = process.env.COMMERCE_CREDENTIAL_KEY) {
  const parsed = keySchema.safeParse(value ?? "");
  return parsed.success ? parsed.data : null;
}

export type MerchantCredentials = { clientId: string; apiKey: string };
const credentialsSchema = z.object({ clientId: z.string().min(1), apiKey: z.string().min(1) }).strict();
const binding = (organisationId: string, outletId: string) => Buffer.from(`${organisationId}:${outletId}`);

export function sealCredentials(credentials: MerchantCredentials, key: Buffer, organisationId: string, outletId: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(binding(organisationId, outletId));
  const body = Buffer.concat([cipher.update(JSON.stringify(credentialsSchema.parse(credentials)), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(".");
}

export function openCredentials(sealed: string, key: Buffer, organisationId: string, outletId: string): MerchantCredentials {
  const [version, iv, tag, body] = sealed.split(".");
  if (version !== "v1" || !iv || !tag || !body) throw new Error("Unreadable sealed credentials.");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAAD(binding(organisationId, outletId));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return credentialsSchema.parse(JSON.parse(Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8")));
}
