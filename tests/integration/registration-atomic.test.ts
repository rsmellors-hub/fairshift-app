import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../helpers/database";
import { getDatabase } from "@/server/db/client";
import { memberships, organisations, sessions, subscriptions, users } from "@/server/db/schema";
import { registerAction } from "@/app/auth-actions";

// F6 (12 Nov 2026): registration checks every field before writing, then creates the account, the
// business shell and the session together. A failed attempt leaves no account, and the retry succeeds.
const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (key: string) => jar.has(key) ? { value: jar.get(key)! } : undefined, set: (key: string, value: string) => jar.set(key, value), delete: (key: string) => jar.delete(key) }) }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); } }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/db/client", () => ({ getDatabase: vi.fn() }));
vi.mock("@/server/notifications/email", async original => ({ ...await original<typeof import("@/server/notifications/email")>(), getEmailAdapter: () => ({ send: async () => ({ status: "UNCONFIGURED" }) }) }));

vi.setConfig({ testTimeout: 120_000 });
beforeEach(() => jar.clear());
afterEach(() => { vi.clearAllMocks(); });
type Db = Awaited<ReturnType<typeof createTestDatabase>>["db"];
const form = (values: Record<string, string>) => { const result = new FormData(); for (const [k, v] of Object.entries(values)) result.set(k, v); return result; };
const outcome = async (action: () => Promise<unknown>) => { try { await action(); return "returned"; } catch (error) { return (error as Error).message; } };
const complete = { name: "Thandi Owner", businessName: "Braamfontein Coffee", country: "South Africa", terms: "yes", email: "thandi@example.test", password: "long-test-password-42" };
const counts = async (db: Db) => ({ users: (await db.select().from(users)).length, organisations: (await db.select().from(organisations)).length, memberships: (await db.select().from(memberships)).length,
  subscriptions: (await db.select().from(subscriptions)).length, sessions: (await db.select().from(sessions)).length });
// Counts added since the start of a test (a fresh test database already holds seeded records).
const added = async (db: Db, base: Awaited<ReturnType<typeof counts>>) => Object.fromEntries(Object.entries(await counts(db)).map(([key, value]) => [key, value - base[key as keyof typeof base]]));
const NOTHING = { users: 0, organisations: 0, memberships: 0, subscriptions: 0, sessions: 0 };

describe("atomic registration", () => {
  it("refuses a form with a missing field before writing anything, and the corrected retry succeeds", async () => {
    const t = await createTestDatabase();
    try {
      vi.mocked(getDatabase).mockReturnValue(t.db);
      const base = await counts(t.db);
      const missing: Record<string, Partial<typeof complete>> = { terms: { terms: "" }, name: { name: " " }, businessName: { businessName: "" }, country: { country: "" } };
      for (const [field, change] of Object.entries(missing)) {
        expect(await outcome(() => registerAction(form({ ...complete, ...change }))), field).toBe("REDIRECT:/register?status=error");
        expect(await added(t.db, base), field).toEqual(NOTHING);
      }
      expect(jar.size).toBe(0);

      expect(await outcome(() => registerAction(form(complete)))).toBe("REDIRECT:/check-email");
      expect(await added(t.db, base)).toEqual({ users: 1, organisations: 1, memberships: 1, subscriptions: 1, sessions: 1 });
      const [user] = await t.db.select().from(users).where(sql`email = ${"thandi@example.test"}`);
      expect(user).toMatchObject({ email: "thandi@example.test", name: "Thandi Owner", firstName: "Thandi", surname: "Owner" });
      expect((await t.db.select().from(memberships).where(sql`user_id = ${user.id}`))[0]).toMatchObject({ userId: user.id, role: "OWNER" });
      expect((await t.db.select().from(organisations).where(sql`name = ${"Braamfontein Coffee"}`))[0]).toMatchObject({ name: "Braamfontein Coffee", country: "South Africa" });
      expect(jar.size).toBe(1);
    } finally { await t.close(); }
  });

  it("rolls the whole account back when a write fails part-way, so the same email can register again", async () => {
    const t = await createTestDatabase();
    try {
      vi.mocked(getDatabase).mockReturnValue(t.db);
      const base = await counts(t.db);
      // The session is the last write: make it fail once the user and business are already inserted.
      await t.db.execute(sql`create function refuse_session() returns trigger language plpgsql as $$ begin raise exception 'session store unavailable'; end $$`);
      await t.db.execute(sql`create trigger refuse_session before insert on auth_sessions for each row execute function refuse_session()`);
      expect(await outcome(() => registerAction(form(complete)))).toBe("REDIRECT:/register?status=error");
      expect(await added(t.db, base)).toEqual(NOTHING);

      await t.db.execute(sql`drop trigger refuse_session on auth_sessions`);
      expect(await outcome(() => registerAction(form(complete)))).toBe("REDIRECT:/check-email");
      expect(await added(t.db, base)).toEqual({ users: 1, organisations: 1, memberships: 1, subscriptions: 1, sessions: 1 });
    } finally { await t.close(); }
  });
});
