import { describe, expect, it } from "vitest";

import nextConfig from "../../next.config";

// Staff statement link tokens travel as Server Function arguments (src/app/staff-actions.ts).
// Next.js logs those arguments in development unless this is off, which would put tokens in logs.
describe("server function logging", () => {
  it("never logs Server Function arguments", () => {
    expect(nextConfig.logging).toMatchObject({ serverFunctions: false });
  });
});
