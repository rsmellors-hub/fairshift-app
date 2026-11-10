import { describe, expect, it } from "vitest";
import { searchCategoriesFor, triggeredByLabel } from "@/server/intelligence/customer-types";
import { buildDiscoveryInput, INFLUENCE_CATEGORIES } from "@/server/intelligence/local-intelligence-contract";

// Design §3 (10 Nov 2026): a location's customer types decide exactly which categories the AI searches,
// with the venue-safety categories always on; the note can only narrow; each finding records its reason.
const base = { runKind: "DAILY" as const, today: "2026-11-10", location: { name: "Gardens", city: "Cape Town", province: null, country: "South Africa", latitude: -33.9, longitude: 18.4, timezone: "Africa/Johannesburg" },
  profile: null, tradingFor: () => [{ start: 420, end: 1020 }], holidays: [] };

describe("customer types drive the local search", () => {
  it("narrows the search to the categories the types switch on, plus whether the venue can open", () => {
    const focus = searchCategoriesFor(["THEATRE_EVENTS", "COMMUTERS"], INFLUENCE_CATEGORIES)!;
    expect(focus.map(row => [row.category, row.triggeredBy])).toEqual([
      ["FESTIVAL_CONCERT_CULTURAL", "THEATRE_EVENTS"], ["ACCESS_DISRUPTION", "COMMUTERS"], ["SERVICE_DISRUPTION", "ALWAYS"], ["EXTREME_WEATHER", "ALWAYS"]]);
    const input = buildDiscoveryInput({ ...base, focus, ownerNote: "Mostly weekday lunch" });
    expect(input.categories.map(row => row.category)).toEqual(["FESTIVAL_CONCERT_CULTURAL", "ACCESS_DISRUPTION", "SERVICE_DISRUPTION", "EXTREME_WEATHER"]);
    expect(input.categories[0].label).toContain("look for: shows at nearby venues");
    expect(input.ownerNote).toContain("may only narrow");
    expect(triggeredByLabel("THEATRE_EVENTS")).toBe("Because you picked Theatre and event-goers");
    expect(triggeredByLabel("ALWAYS")).toBe("Checked at every venue: can it open?");
  });
  it("searches every category, as before, until customer types are chosen", () => {
    expect(searchCategoriesFor([], INFLUENCE_CATEGORIES)).toBeNull();
    expect(buildDiscoveryInput({ ...base, focus: null }).categories).toHaveLength(INFLUENCE_CATEGORIES.length);
  });
});
