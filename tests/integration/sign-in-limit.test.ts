import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../helpers/database";
import { registerIdentity, signIn } from "@/server/auth/identity";

// Only failed attempts add up to the per-account sign-in limit; a correct sign-in clears the count.
describe("sign-in limit", () => {
  it("lets an account sign in correctly many times, and still stops repeated wrong passwords", async () => {
    const t = await createTestDatabase();
    try {
      const email = "limit.check@example.test", password = "a-long-test-password-42";
      await registerIdentity(t.db, { email, password });
      for (let i = 0; i < 15; i++) await expect(signIn(t.db, email, password)).resolves.toHaveLength(43);
      for (let i = 0; i < 10; i++) await expect(signIn(t.db, email, "wrong-password-123")).rejects.toThrow("Email or password was not accepted.");
      await expect(signIn(t.db, email, password)).rejects.toThrow(/Too many attempts/);
    } finally { await t.close(); }
  });
});
