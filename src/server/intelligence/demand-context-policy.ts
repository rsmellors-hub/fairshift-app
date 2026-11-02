// FS-DEMAND-CONTEXT-DEC-001. The closed set of contextual-demand scenarios and the planning
// assumption code attaches to each. These percentages are versioned product policy. They are
// not learned, not a measure of any event's effect, and not forecast accuracy. AI may only
// choose a scenario by name; it never supplies or sees itself as setting a number.

export const DEMAND_CONTEXT_POLICY_VERSION = "fs-demand-context-policy-v1";
export const DEMAND_SCENARIOS = ["NONE", "MINOR_UP", "MODERATE_UP", "MINOR_DOWN", "MODERATE_DOWN"] as const;
export type DemandScenario = typeof DEMAND_SCENARIOS[number];

// Basis points, so the arithmetic stays in integers.
export const SCENARIO_ADJUSTMENT_BPS: Readonly<Record<DemandScenario, number>> = Object.freeze({ NONE: 0, MINOR_UP: 500, MODERATE_UP: 1000, MINOR_DOWN: -500, MODERATE_DOWN: -1000 });

export const scenarioDirection = (scenario: DemandScenario): "UP" | "DOWN" | null => SCENARIO_ADJUSTMENT_BPS[scenario] > 0 ? "UP" : SCENARIO_ADJUSTMENT_BPS[scenario] < 0 ? "DOWN" : null;

const ALLOWED_BPS = new Set(Object.values(SCENARIO_ADJUSTMENT_BPS));

// Applies a policy assumption to expected transactions held in thousandths, rounding half up.
// Refuses anything outside the policy, so no other number can reach staffing through this path.
export function applyDemandAdjustment(milliTransactions: number, adjustmentBps: number) {
  if (!ALLOWED_BPS.has(adjustmentBps)) throw new Error("Demand adjustment is outside the versioned policy.");
  return Math.floor((milliTransactions * (10_000 + adjustmentBps) + 5_000) / 10_000);
}
