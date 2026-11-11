import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../helpers/database";
import { consumeLimit, hashPassword, signIn, SITE_LIMITS } from "@/server/auth/identity";
import { users } from "@/server/db/schema";

// F7 (12 Nov 2026): the site-wide sign-in and registration caps sit far above real traffic, so a burst
// that would have hit the old caps (200 sign-ins, 100 registrations in 15 minutes) locks nobody out.
describe("site-wide limits", () => {
  it("are raised well above the old caps", () => {
    expect(SITE_LIMITS.login).toBeGreaterThanOrEqual(2_000);
    expect(SITE_LIMITS.registration).toBeGreaterThanOrEqual(500);
  });

  it("let a real person sign in after a burst of attempts that would have locked everyone out before", async () => {
    const t = await createTestDatabase();
    try {
      const password = "long-test-password-42";
      await t.db.insert(users).values({ id: randomUUID(), email: "real@example.test", name: "Real", passwordHash: await hashPassword(password) });
      // 250 attempts in the window from elsewhere: over the old cap of 200.
      for (let i = 0; i < 250; i++) await consumeLimit(t.db, "login-global", SITE_LIMITS.login);
      expect(await signIn(t.db, "real@example.test", password)).toMatch(/^[A-Za-z0-9_-]{43}$/);
      // The cap still stops a flood.
      await expect((async () => { for (let i = 0; i < SITE_LIMITS.login; i++) await consumeLimit(t.db, "login-global", SITE_LIMITS.login); })()).rejects.toThrow("Too many attempts");
    } finally { await t.close(); }
  });
});
