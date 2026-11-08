import { randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../helpers/database";
import { issueSession, registerIdentity } from "@/server/auth/identity";
import { getDatabase } from "@/server/db/client";
import { notificationDeliveries, notifications, users } from "@/server/db/schema";
import Account from "@/app/account/page";
import CheckEmail from "@/app/check-email/page";
import Faq from "@/app/faq/page";
import Home from "@/app/page";
import Pricing from "@/app/pricing/page";
import Product from "@/app/product/page";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (key: string) => jar.has(key) ? { value: jar.get(key)! } : undefined, set: (key: string, value: string) => jar.set(key, value), delete: (key: string) => jar.delete(key) }), headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); }, usePathname: () => "/" }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/db/client", () => ({ getDatabase: vi.fn() }));

vi.setConfig({ testTimeout: 120_000 });
type Db = Awaited<ReturnType<typeof createTestDatabase>>["db"];
const withDb = async (run: (db: Db) => Promise<void>) => { const t = await createTestDatabase(); try { vi.mocked(getDatabase).mockReturnValue(t.db); await run(t.db); } finally { await t.close(); } };
const params = <T,>(value: T) => ({ searchParams: Promise.resolve(value) });
const INTERNALS = /provider accept|accepted by provider|queue|dispatcher|retry pending|UNCONFIGURED|webhook/i;

async function account(db: Db, verified = false) {
  const user = await registerIdentity(db, { email: "new.owner@example.test", password: "long-test-password-42" });
  if (verified) await db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, user.id));
  jar.set("fairshift_session", await issueSession(db, user.id));
  return user;
}
async function verificationEmail(db: Db, userId: string, status: string) {
  const id = randomUUID();
  await db.insert(notifications).values({ id, userId, recipientEmail: "new.owner@example.test", eventKey: `identity:${id}`, kind: "VERIFY_EMAIL", entityId: userId, title: "Verify", body: "Verify", href: "/account" });
  // A database trigger creates the delivery row with the notification.
  await db.update(notificationDeliveries).set({ status }).where(eq(notificationDeliveries.notificationId, id));
}

beforeEach(() => jar.clear());
afterEach(() => vi.clearAllMocks());

describe("check your email", () => {
  it("says it sent the link only when the email service took it, masks the address and shows no delivery internals", () => withDb(async db => {
    const user = await account(db);
    await verificationEmail(db, user.id, "ACCEPTED");
    const html = renderToStaticMarkup(await CheckEmail(params({})));
    expect(html).toContain("We sent a verification link to");
    expect(html).toContain("n•••@example.test");
    expect(html).not.toContain("new.owner@example.test");
    expect(html).toContain("Resend verification email");
    expect(html).not.toMatch(INTERNALS);
  }));

  it("doesn't claim a link was sent when delivery isn't confirmed", () => withDb(async db => {
    const user = await account(db);
    await verificationEmail(db, user.id, "UNCONFIGURED");
    const html = renderToStaticMarkup(await CheckEmail(params({})));
    expect(html).not.toContain("We sent a verification link");
    expect(html).toContain("We couldn’t send a verification link");
    expect(html).toContain("Send verification email");
    expect(html).not.toMatch(INTERNALS);
  }));

  it("explains the resend limit, and sends a verified person onward", () => withDb(async db => {
    await account(db);
    expect(renderToStaticMarkup(await CheckEmail(params({ status: "limited" })))).toContain("Too many emails requested");
    const [row] = await db.select().from(users);
    await db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, row.id));
    await expect(CheckEmail(params({}))).rejects.toThrow("REDIRECT:/account");
  }));

  it("isn't reachable signed out", () => withDb(async () => {
    await expect(CheckEmail(params({}))).rejects.toThrow("REDIRECT:/sign-in");
  }));
});

describe("account", () => {
  it("sends an unverified person to check their email, and shows a verified person no delivery internals", () => withDb(async db => {
    const user = await account(db);
    await expect(Account(params({}))).rejects.toThrow("REDIRECT:/check-email");
    await db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, user.id));
    const html = renderToStaticMarkup(await Account(params({})));
    expect(html).toContain("Your account");
    expect(html).not.toMatch(INTERNALS);
  }));
});

describe("public pages", () => {
  // Owner decision, 8 November 2026: rand first, incl. 15% VAT; the US dollar amount PayPal bills is a labelled line.
  const billed = (rand: string, per: string, usd: string) => `${rand}/${per} incl. 15% VAT — billed by PayPal as US$${usd}; your bank or PayPal converts at its own rate.`;
  it("shows the catalogue's prices rand first, annual and monthly, with the US dollar amount PayPal bills", async () => {
    const annual = renderToStaticMarkup(await Pricing(params({})));
    for (const text of ["Venue", "Group", "1 location", "Up to 5 locations", "R4,990", "R11,490", billed("R4,990", "year", "301.73"), billed("R11,490", "year", "694.76"), "Save 17%", "6+ locations", "Custom", "workers are never charged", "VAT is never applied to worker earnings or tips"]) expect(annual).toContain(text);
    const monthly = renderToStaticMarkup(await Pricing(params({ period: "MONTHLY" })));
    for (const text of ["R499", "R1,149", billed("R499", "month", "30.17"), billed("R1,149", "month", "69.48")]) expect(monthly).toContain(text);
    expect(annual.indexOf("R4,990")).toBeLessThan(annual.indexOf("US$301.73"));
    expect(monthly.indexOf("R499")).toBeLessThan(monthly.indexOf("US$30.17"));
    for (const html of [annual, monthly]) {
      expect(html).not.toContain("£");
      expect(html).not.toMatch(/\bGBP\b|Single Outlet|Multi Outlet/);
      // No converted or derived figure is shown as the charge.
      expect(html).not.toMatch(/≈|R415|R957|billed annually/);
      expect(html).not.toMatch(/no (currency )?conversion fees?/i);
    }
  });

  it("makes none of the prohibited claims and keeps no unresolved placeholders", async () => {
    const pages = [renderToStaticMarkup(Home()), renderToStaticMarkup(Product()), renderToStaticMarkup(Faq()), renderToStaticMarkup(await Pricing(params({})))];
    for (const html of pages) {
      expect(html).not.toMatch(/zettle/i);
      expect(html).not.toMatch(/till login/i);
      expect(html).not.toMatch(/refunds are taken off/i);
      expect(html).not.toMatch(/\[[A-Za-z ]*to be confirmed\]/i);
      expect(html).not.toMatch(/hourly forecast/i);
    }
    expect(pages[0]).toContain("The right people. The right place. The right time. The right pay.");
    expect(pages[2]).toContain("expected transactions by time of day");
  });

  it("orders the home page's calls to action as start, demo, sign in", () => {
    const hero = renderToStaticMarkup(Home()).split('class="cta-row"')[1];
    expect(hero.indexOf("Start your business")).toBeLessThan(hero.indexOf("Try the demo"));
    expect(hero.indexOf("Try the demo")).toBeLessThan(hero.indexOf("Sign in"));
  });
});
