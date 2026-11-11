import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { designV2Enabled } from "@/lib/design-flag";

describe("NEXT_PUBLIC_DESIGN_V2", () => {
  it("is on by default and for any value but off, false or 0", () => {
    expect(designV2Enabled(undefined)).toBe(true);
    expect(designV2Enabled("")).toBe(true);
    expect(designV2Enabled("on")).toBe(true);
    expect(designV2Enabled("1")).toBe(true);
  });
  it("is off for off, false or 0, in any case", () => {
    for (const value of ["off", "OFF", " false ", "0"]) expect(designV2Enabled(value)).toBe(false);
  });
  it("scopes every design-v2 rule to html[data-design=\"v2\"], so the flag-off look is unchanged", () => {
    const css = readFileSync(new URL("../../src/app/design-v2.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    // Each selector list before a block, outside @media headers, must name the v2 scope in every selector.
    const selectors = [...css.matchAll(/([^{}]+)\{[^{}]*\}/g)].map(match => match[1].trim()).filter(Boolean);
    expect(selectors.length).toBeGreaterThan(50);
    for (const list of selectors) for (const selector of list.replace(/^@media[^{]*$/, "").split(",")) {
      const text = selector.trim();
      if (!text || text.startsWith("@media")) continue;
      expect(text, text).toMatch(/^html\[data-design="v2"\]/);
    }
  });
});
