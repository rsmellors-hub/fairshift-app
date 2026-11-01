import { randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../helpers/database";
import { entitled } from "../helpers/onboarding";
import { resolveScope } from "@/server/auth/access";
import { signIn, hashPassword } from "@/server/auth/identity";
import { inviteMember } from "@/server/auth/tenancy";
import { getDatabase } from "@/server/db/client";
import { commerceConnections, commerceWorkerIdentities, identityTokens, memberships, notifications, organisations, outlets, subscriptions, users, workers } from "@/server/db/schema";
import { getOwnerSetup } from "@/server/product/owner-setup";
import { redeemInvitationAction, registerAction, signInAction } from "@/app/auth-actions";
import Invite from "@/app/invite/page";
import Register from "@/app/register/page";
import SignIn from "@/app/sign-in/page";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (key: string) => jar.has(key) ? { value: jar.get(key)! } : undefined, set: (key: string, value: string) => jar.set(key, value), delete: (key: string) => jar.delete(key) }) }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); } }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/db/client", () => ({ getDatabase: vi.fn() }));
vi.mock("@/server/notifications/email", async original => ({ ...await original<typeof import("@/server/notifications/email")>(), getEmailAdapter: () => ({ send: async () => ({ status: "UNCONFIGURED" }) }) }));

vi.setConfig({ testTimeout: 120_000 });
type Db = Awaited<ReturnType<typeof createTestDatabase>>["db"];
const withDb = async (run: (db: Db) => Promise<void>) => { const t = await createTestDatabase(); try { vi.mocked(getDatabase).mockReturnValue(t.db); await run(t.db); } finally { await t.close(); } };
const form = (values: Record<string, string>) => { const result = new FormData(); for (const [k, v] of Object.entries(values)) result.set(k, v); return result; };
const outcome = async (action: () => Promise<unknown>) => { try { await action(); return "returned"; } catch (error) { return (error as Error).message; } };
const password = "long-test-password-42";

async function business(db: Db, tier: "SINGLE_OUTLET" | "MULTI_OUTLET" = "MULTI_OUTLET") {
  const organisationId = randomUUID(), ownerId = randomUUID(), membershipId = randomUUID(), locationId = randomUUID();
  await db.insert(organisations).values({ id: organisationId, name: "Retailer", country: "United Kingdom" });
  await db.insert(subscriptions).values({ id: randomUUID(), organisationId, requestId: randomUUID() });
  await entitled(db, organisationId);
  await db.update(subscriptions).set({ tier, locationLimit: tier === "MULTI_OUTLET" ? 5 : 1 }).where(eq(subscriptions.organisationId, organisationId));
  await db.insert(outlets).values({ id: locationId, organisationId, name: "Northgate", timezone: "Europe/London", country: "United Kingdom" });
  await db.insert(users).values({ id: ownerId, email: `owner-${ownerId}@example.test`, name: "Owner", passwordHash: "x", emailVerifiedAt: new Date() });
  await db.insert(memberships).values({ id: membershipId, userId: ownerId, organisationId, role: "OWNER" });
  return { organisationId, locationId, scope: await resolveScope(db, ownerId, membershipId, locationId) };
}
const step = (steps: Awaited<ReturnType<typeof getOwnerSetup>>, key: string) => steps.find(row => row.key === key);

beforeEach(() => jar.clear());
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });

describe("invited people reach their invitation", () => {
  it("someone invited who registers goes back to the invitation, gets no owner verification email, and joins verified", () => withDb(async db => {
    const b = await business(db);
    const { token } = await inviteMember(db, b.scope, { role: "TEAM_MEMBER", email: "casey@example.test", firstName: "Casey", surname: "Person", telephone: "+441130000000" });
    const signedOut = renderToStaticMarkup(await Invite({ searchParams: Promise.resolve({}) }));
    expect(signedOut).toContain('href="/register?next=invite"');
    expect(signedOut).toContain('href="/sign-in?next=invite"');
    expect(signedOut).not.toContain('name="token"');
    expect(renderToStaticMarkup(await Register({ searchParams: Promise.resolve({ next: "invite" }) }))).toContain('name="next"');
    expect(await outcome(() => registerAction(form({ email: "casey@example.test", password, next: "invite" })))).toBe("REDIRECT:/invite");
    expect((await db.select().from(notifications).where(eq(notifications.kind, "VERIFY_EMAIL")))).toHaveLength(0);
    expect(renderToStaticMarkup(await Invite({ searchParams: Promise.resolve({}) }))).toContain("casey@example.test");
    expect(await outcome(() => redeemInvitationAction(form({ token })))).toMatch(/^REDIRECT:/);
    const [user] = await db.select().from(users).where(eq(users.email, "casey@example.test"));
    expect(user.emailVerifiedAt).not.toBeNull();
    expect((await db.select().from(memberships).where(eq(memberships.userId, user.id)))[0]).toMatchObject({ role: "TEAM_MEMBER", organisationId: b.organisationId });
  }));

  it("an invited person with an account signs in and goes back to the invitation", () => withDb(async db => {
    await db.insert(users).values({ id: randomUUID(), email: "back@example.test", name: "", passwordHash: await hashPassword(password) });
    expect(renderToStaticMarkup(await SignIn({ searchParams: Promise.resolve({ next: "invite" }) }))).toContain('name="next"');
    expect(await outcome(() => signInAction(form({ email: "back@example.test", password, next: "invite" })))).toBe("REDIRECT:/invite");
    expect(await signIn(db, "back@example.test", password)).toBeTruthy();
  }));

  it("only the known continuation is honoured, and a business owner still verifies by email", () => withDb(async db => {
    expect(await outcome(() => registerAction(form({ email: "owner-new@example.test", password, next: "https://elsewhere.example/" })))).toBe("REDIRECT:/check-email");
    expect(await db.select().from(notifications).where(eq(notifications.kind, "VERIFY_EMAIL"))).toHaveLength(1);
    expect(await db.select().from(identityTokens)).toHaveLength(1);
  }));

  it("a wrong email's sign-in doesn't lose the continuation", () => withDb(async () => {
    expect(await outcome(() => signInAction(form({ email: "nobody@example.test", password, next: "invite" })))).toBe("REDIRECT:/sign-in?status=error&next=invite");
    expect(jar.has("fairshift_session")).toBe(false);
  }));
});

describe("Owner setup checklist", () => {
  it("doesn't offer reference data or imports as a setup path", () => withDb(async db => {
    const steps = await getOwnerSetup(db, (await business(db)).scope, false);
    expect(JSON.stringify(steps)).not.toMatch(/reference|import|Zettle/i);
    expect(step(steps, "history")?.detail).toContain("28 days");
    expect(step(steps, "forecast")?.done).toBe(false);
  }));

  it("asks a Multi Outlet business for its other locations, and not a Single Outlet one", () => withDb(async db => {
    const multi = await business(db);
    expect(step(await getOwnerSetup(db, multi.scope, false), "locations")?.done).toBe(false);
    await db.insert(outlets).values({ id: randomUUID(), organisationId: multi.organisationId, name: "Southgate", timezone: "Europe/London", country: "United Kingdom" });
    expect(step(await getOwnerSetup(db, multi.scope, false), "locations")?.done).toBe(true);
    expect(step(await getOwnerSetup(db, (await business(db, "SINGLE_OUTLET")).scope, false), "locations")).toBeUndefined();
  }));

  it("asks for Square mapping only once a location is connected and has casual workers, until they're all mapped", () => withDb(async db => {
    const b = await business(db), workerId = randomUUID();
    await db.insert(workers).values({ id: workerId, organisationId: b.organisationId, locationId: b.locationId, displayName: "Casey", workerType: "CASUAL", attributionCode: "CASEY" });
    expect(step(await getOwnerSetup(db, b.scope, false), "mapping")).toBeUndefined();
    const connectionId = randomUUID();
    await db.insert(commerceConnections).values({ id: connectionId, organisationId: b.organisationId, outletId: b.locationId, provider: "SQUARE", status: "CONNECTED", providerMerchantId: "M", providerLocationId: "L", providerEnvironment: "SANDBOX", sealedCredentials: "fixture", connectedAt: new Date() });
    expect(step(await getOwnerSetup(db, b.scope, false), "mapping")?.done).toBe(false);
    await db.insert(commerceWorkerIdentities).values({ id: randomUUID(), organisationId: b.organisationId, outletId: b.locationId, workerId, provider: "SQUARE", providerMerchantId: "M", providerTeamMemberId: "TM", status: "ACTIVE", createdAt: new Date() });
    expect(step(await getOwnerSetup(db, b.scope, false), "mapping")?.done).toBe(true);
  }));
});
