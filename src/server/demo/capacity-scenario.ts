import { isDemoOrganisation } from "@/server/demo/organisation";
import { localDate, shiftDate } from "@/server/intelligence/forecast";
import type { LocalSignalView } from "@/server/intelligence/local-intelligence-service";
import { SA_REFERENCE_ORGANISATION, saReferenceLocation } from "@/server/reference/sa-reference";

// DEMO CAPACITY scenario (Owner instruction, 8 November 2026): one synthetic capacity disruption at the
// fictional demo business's Rosebank location, so the Owner's disruption alert and the early shift
// notice can be seen without waiting for a real disruption. It is defined here and never stored: the
// database keeps "accepted" for findings whose source FairShift checked and the search opened, and this
// has neither, so it is never recorded as an AI finding. It exists only for the fictional South African
// demo business while that business is a configured demo organisation, never for any other business.
// Being code, it is untouched by re-provisioning, a demo reset or a discovery run, and it is always
// dated tomorrow, Johannesburg time. Every view labels it DEMO. It changes no demand, staffing or pay.

export const DEMO_SCENARIO_MODEL = "fairshift-demo-scenario";
export const DEMO_SCENARIO_LOCATION = "SA01";

export function demoCapacityScenario(input: { organisationId: string; outletId: string; timeZone: string; now: Date }): LocalSignalView | null {
  if (input.organisationId !== SA_REFERENCE_ORGANISATION.id || !isDemoOrganisation(input.organisationId)) return null;
  if (input.outletId !== saReferenceLocation(DEMO_SCENARIO_LOCATION).id) return null;
  const date = shiftDate(localDate(input.now, input.timeZone), 1);
  return {
    key: `demo_capacity_${date}`, id: `demo-capacity-${date}`, runId: "demo-scenario", status: "ACCEPTED", effectType: "CAPACITY", direction: null, sizeBand: null,
    validFrom: date, validTo: date, startMinute: null, endMinute: null, shiftBlocks: [], impact: 330,
    category: "SERVICE_DISRUPTION", categoryLabel: "DEMO scenario", otherLabel: null, name: "DEMO scenario: planned water interruption (synthetic)",
    dateCertainty: "FIXED", roles: ["FOH", "BOH"], severity: "HIGH", closureLikely: true, confidence: "HIGH", sourceTier: "DEMO",
    reasoning: "A synthetic all-day water interruption that would stop Rosebank trading, made so the disruption alert and the early shift notice can be shown.",
    sourceUrl: "", sourceTitle: null, sourceCheck: "NOT_CHECKED", consultedInSearch: "NO",
    serverNote: "Made by FairShift for the demonstration. It is not a real event, and no AI found it.", rejectionCode: null,
    responseId: null, model: DEMO_SCENARIO_MODEL, responseModel: null, foundAt: input.now, use: "ALERT", demo: true,
  };
}
