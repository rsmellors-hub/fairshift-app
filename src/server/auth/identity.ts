import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database, DatabaseSession } from "@/server/db/client";
import { authLimits, identityTokens, sessions, users } from "@/server/db/schema";



export const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
export const newToken = () => randomBytes(32).toString("base64url");
const emailSchema = z.string().trim().toLowerCase().email().max(254);
const passwordSchema = z.string().min(12).max(128);
function derive(password: string, salt: string) {
  return new Promise<Buffer>((resolve,reject) => scrypt(password,salt,64,{N:131072,r:8,p:1,maxmem:256*1024*1024},(e,key) => e ? reject(e) : resolve(key)));
}
export async function hashPassword(password: string) {
  passwordSchema.parse(password);
  const salt = randomBytes(16).toString("hex");
  return `scrypt:${salt}:${(await derive(password,salt)).toString("hex")}`;
}
export async function checkPassword(password: string, encoded: string) {
  const [algorithm,salt,key] = encoded.split(":");
  if (algorithm !== "scrypt" || !salt || !key || password.length > 128) return false;
  const candidate = await derive(password,salt), expected = Buffer.from(key,"hex");
  return candidate.length === expected.length && timingSafeEqual(candidate,expected);
}
// Database-backed limits survive process restarts and concurrent app instances.
export async function consumeLimit(db: DatabaseSession, key: string, maximum = 10) {
  const now = new Date();
  const [row] = await db.insert(authLimits).values({key:tokenHash(key),count:1,resetsAt:new Date(now.getTime()+15*60_000)})
    .onConflictDoUpdate({target:authLimits.key,set:{count:sql`case when ${authLimits.resetsAt} < ${now} then 1 else ${authLimits.count}+1 end`,resetsAt:sql`case when ${authLimits.resetsAt} < ${now} then ${new Date(now.getTime()+15*60_000)} else ${authLimits.resetsAt} end`}}).returning();
  if (row.count > maximum) throw new Error("Too many attempts. Try again later.");
}
export async function clearLimit(db: Database, key: string) {
  await db.delete(authLimits).where(eq(authLimits.key,tokenHash(key)));
}
export async function registerIdentity(db: Database, input: unknown) {
  const value = z.object({email:emailSchema,password:passwordSchema}).strict().parse(input);
  await consumeLimit(db,`register:${value.email}`,5);
  const passwordHash = await hashPassword(value.password);
  const [user] = await db.insert(users).values({email:value.email,id:randomUUID(),name:"",passwordHash}).returning({id:users.id,email:users.email,name:users.name});
  return user;
}
export async function signIn(db: Database, email: string, password: string) {
  const normalized = emailSchema.parse(email);
  await consumeLimit(db,"login-global",200);
  await consumeLimit(db,`login:${normalized}`);
  const [user] = await db.select().from(users).where(eq(users.email,normalized));
  // A real scrypt cost is paid even for an unknown account.
  const dummy = `scrypt:00000000000000000000000000000000:${"00".repeat(64)}`;
  const valid = await checkPassword(password,user?.passwordHash ?? dummy);
  if (!user || !valid) throw new Error("Email or password was not accepted.");
  // A correct sign-in clears this account's attempt count, so only failed attempts add up to the limit;
  // the business-wide limit on sign-in attempts still applies.
  await clearLimit(db,`login:${normalized}`);
  return issueSession(db,user.id);
}
export async function issueSession(db: DatabaseSession, userId: string) {
  const token = newToken();
  await db.insert(sessions).values({id:randomUUID(),userId,tokenHash:tokenHash(token),expiresAt:new Date(Date.now()+7*86400_000)});
  return token;
}
export async function resolveSession(db: DatabaseSession, token?: string) {
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const [row] = await db.select({user:users,session:sessions}).from(sessions).innerJoin(users,eq(users.id,sessions.userId))
    .where(and(eq(sessions.tokenHash,tokenHash(token)),gt(sessions.expiresAt,new Date())));
  return row ?? null;
}
export async function revokeSession(db: DatabaseSession, token: string) {
  await db.update(sessions).set({expiresAt:new Date(0)}).where(eq(sessions.tokenHash,tokenHash(token)));
}
export async function createIdentityToken(db: DatabaseSession, userId: string, purpose: "VERIFY_EMAIL" | "RESET_PASSWORD") {
  const token = newToken();
  await db.insert(identityTokens).values({id:randomUUID(),userId,purpose,tokenHash:tokenHash(token),expiresAt:new Date(Date.now()+60*60_000)});
  return token;
}
export async function redeemIdentityToken(db: Database, token: string, purpose: "VERIFY_EMAIL" | "RESET_PASSWORD", password?: string) {
  const passwordHash = purpose === "RESET_PASSWORD" ? await hashPassword(password ?? "") : undefined;
  return db.transaction(async tx => {
    const [row] = await tx.select().from(identityTokens).where(and(eq(identityTokens.tokenHash,tokenHash(token)),eq(identityTokens.purpose,purpose))).for("update");
    if (!row || row.usedAt || row.expiresAt <= new Date()) throw new Error("Link expired or unavailable.");
    await tx.update(identityTokens).set({usedAt:new Date()}).where(eq(identityTokens.id,row.id));
    await tx.update(users).set(purpose === "VERIFY_EMAIL" ? {emailVerifiedAt:new Date()} : {passwordHash}).where(eq(users.id,row.userId));
    if (purpose === "RESET_PASSWORD") await tx.update(identityTokens).set({usedAt:new Date()}).where(eq(identityTokens.userId,row.userId));
    if (purpose === "RESET_PASSWORD") await tx.update(sessions).set({expiresAt:new Date(0)}).where(eq(sessions.userId,row.userId));
    return row.userId;
  });
}
