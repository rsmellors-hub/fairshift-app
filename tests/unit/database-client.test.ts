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
