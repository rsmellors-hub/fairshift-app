import { afterEach, describe, expect, it, vi } from "vitest";
import { getDatabase } from "@/server/db/client";

const globals = globalThis as unknown as { fairshiftPool?: { end(): Promise<void> }; fairshiftDatabase?: unknown };
afterEach(async () => {
  await globals.fairshiftPool?.end();
  delete globals.fairshiftPool;
  delete globals.fairshiftDatabase;
  vi.unstubAllEnvs();
});

describe("database client", () => {
  it("reuses one connection pool in production instead of opening a pool per call", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", "postgres://fairshift@127.0.0.1:1/unused");
    const first = getDatabase();
    expect(getDatabase()).toBe(first);
    expect(globals.fairshiftDatabase).toBe(first);
  });
});

describe("database pool errors", () => {
  it("logs an idle-client error by name and does not crash the process", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", "postgres://fairshift@127.0.0.1:1/unused");
    getDatabase();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = Object.assign(new Error("terminating connection password=secret"), { name: "DatabaseError" });
    const pool = globals.fairshiftPool as unknown as { emit(event: string, error: Error): boolean };
    expect(() => pool.emit("error", failure)).not.toThrow();
    expect(logged).toHaveBeenCalledWith("database pool error", { name: "DatabaseError" });
    expect(JSON.stringify(logged.mock.calls)).not.toContain("secret");
    logged.mockRestore();
  });
});
