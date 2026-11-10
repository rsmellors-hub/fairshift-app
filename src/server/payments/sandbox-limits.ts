// Sandbox payout guardrails for every business on the hosted PayPal Sandbox deployment (Owner decision
// 10 Nov 2026, item 1): at most 5 payouts and US$100 a day per business. The demo business is included.
export const SANDBOX_PAYOUT_LIMITS = { payoutsPerDay: 5, usdMinorPerDay: 100_00 } as const;
