import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEMO_HOURS_RULE, DEMO_SHIFT_RULES } from "@/server/demo/settings-seed";

// R1 (Owner decisions, 9 November 2026): shift-length rules, the offer-round window and the guaranteed-hours
// alert are each business's and location's stored settings (location_shift_rules, organisation_hours_rules).
// The demo business's values exist only as seed data; the code that cuts shifts and runs offer rounds reads
// the stored settings and contains none of them.
describe("offer and shift settings are stored settings, not constants", () => {
  const modules = ["src/server/scheduling/shift-rules.ts", "src/server/scheduling/shift-suggestions.ts", "src/app/manager/suggested-shifts.tsx", "src/server/intelligence/ai-staffing-contract.ts"];
  it("keeps the demo values in the seed module only", () => {
    expect(DEMO_SHIFT_RULES).toEqual({ minMinutes: 240, maxMinutes: 480, preferredMinutes: 360, firstRoundMinutes: 120, firstRoundCutoffMinutes: 720 });
    expect(DEMO_HOURS_RULE).toEqual({ weeklyThresholdMinutes: 1200, referenceWeeks: 12 });
    for (const path of modules) {
      const source = readFileSync(path, "utf8");
      expect(source, path).not.toMatch(/settings-seed|DEMO_SHIFT_RULES|DEMO_HOURS_RULE/);
      for (const value of ["240", "480", "360", "720", "1200", "20 * 60", "12 * 60"]) expect(source.includes(`= ${value}`) || source.includes(`: ${value}`), `${path} ${value}`).toBe(false);
    }
  });
});
