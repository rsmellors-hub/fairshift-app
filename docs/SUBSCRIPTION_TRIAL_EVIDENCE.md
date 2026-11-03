# Subscription trial evidence (FS-SUBSCRIPTION-TRIAL-001)

Decision: FS-SUBSCRIPTION-TRIAL-DEC-001 (product specification, section 1). Every new self-service subscription starts with a 30-day free trial through PayPal Subscriptions, then continues at the unchanged catalogue price.

**Status:** implemented and VERIFIED locally against PayPal Sandbox on 3 November 2026. NOT deployed. Hosted checkout keeps using whatever plan IDs are configured on Render until those four variables are switched.

## What changed

| File | Change |
| --- | --- |
| `src/server/billing/plans.ts` | Catalogue names now end in ", 30-day trial". Each entry keeps its original name as `legacyName`. `TRIAL_DAYS = 30`. `providerPlan` allows a missing `pricing_scheme` on a `TRIAL` cycle only. `assertCommercialPlan` takes an optional `shapes` argument, which defaults to `["TRIAL"]`. |
| `src/server/billing/service.ts` | `reconcile` validates with `["TRIAL","LEGACY"]`. `startSubscription` still uses the default, so checkout accepts the trial shape only. |
| `scripts/provision-paypal-subscriptions.ts` | Existing plans with legacy names are recognised and validated against the legacy shape, then left untouched. Missing trial plans are created as a 30-day free `TRIAL` cycle (sequence 1) followed by a `REGULAR` cycle (sequence 2). |
| `src/app/components/plan-cards.tsx`, `src/app/pricing/page.tsx`, `src/app/page.tsx`, `src/app/faq/page.tsx` | The four authorised pieces of trial copy. |
| `tests/helpers/subscription-plans.ts` | `planFixture` is now the trial shape. Adds `legacyPlanFixture` and `regularCycleOf`. |
| `tests/unit/subscription-catalogue.test.ts` | Trial acceptance and rejection cases, plus reconciliation of trial and legacy plans. |
| `tests/integration/subscriptions.test.ts` | A legacy plan is refused at checkout but still reconciles, and a plan matching neither shape fails reconciliation. Also updates the existing wrong-price case to use the regular cycle. |
| `tests/integration/subscription-webhook-route.test.ts` | The existing wrong-price case now targets the regular cycle. |
| `docs/FAIRSHIFT_PRODUCT_UX_SPEC.md` | The decision record and the pointer in section 8. |

Unchanged: prices, intervals, location limits, Enterprise, the entitlement rule, subscription statuses, the webhook route, onboarding order, worker payouts, the database schema and `.env.example`.

## Validation rules

- **Checkout (trial shape only).** Exactly two cycles: a `TRIAL` cycle with sequence 1, `total_cycles` 1, `DAY` × 30 and no `pricing_scheme`, and a `REGULAR` cycle with sequence 2, `total_cycles` 0, the catalogue interval × 1 and the catalogue GBP price. There must be no setup fee, a zero tax percentage, `quantity_supported` false and status `ACTIVE`. Rejected: trials of 29 or 31 days, a trial in `MONTH`, a priced trial (including a £0 price), two trial cycles, wrong sequence numbers, a missing regular or trial cycle, a regular cycle without a price, and a legacy plan.
- **Reconciliation.** Either the trial shape or the legacy shape (one `REGULAR` cycle at sequence 1 at the catalogue price). Status may be inactive, as before. Anything else fails closed.

## Automated verification (VERIFIED, executed 3 November 2026)

- `vitest run`: 69 test files and 866 tests, all passed (unit and integration).
- `tsc --noEmit`: passed.
- `eslint .`: passed.

## PayPal Sandbox verification

| Step | Result | Status |
| --- | --- | --- |
| Read-only provisioning run before apply | The four original plans were recognised as legacy and passed legacy validation. The four trial plans were reported missing. | VERIFIED |
| `--apply` (Sandbox, approved by the Owner in session) | PayPal accepted the trial plan shape. Four plans were created under the existing FairShift product: `P-1048…`, `P-5A68…`, `P-6CS9…`, `P-57D6…`. No existing product, plan or webhook was changed. | VERIFIED |
| Each new plan fetched back and checked | All four passed checkout validation (trial shape only). A later read-only run reported no missing plans, with all eight plans valid. | VERIFIED |
| Local `.env.local` switched to the trial plan IDs | All four variables were updated. The old values are kept in a git-ignored local backup. | VERIFIED |
| Sandbox subscription (Single Outlet Monthly), approved by the Owner with the Sandbox personal account | PayPal status `ACTIVE` while in the trial. `start_time` 2026-11-03T09:09:37Z, `next_billing_time` 2026-12-03T10:00:00Z (30.03 days). Cycle executions: `TRIAL` sequence 1 (`total_cycles` 1, `cycles_remaining` 0) and `REGULAR` sequence 2. No last payment, and outstanding balance GBP 0.0. | VERIFIED |
| FairShift entitlement during the trial | Stored status `ACTIVE`, verified, on the new trial plan, Single Outlet, location limit 1. `isEntitled` is true. After returning from PayPal, the app moved the Owner on to workplace setup. | VERIFIED |

Method note: the local run used a disposable Postgres cluster migrated from the repository's migrations. No email provider is configured locally, so the single test user's email was marked verified directly in that scratch database. Email verification was not under test. The scratch database was then discarded.

## Not verified

- Hosted behaviour on Render. The four Render plan-ID variables still need switching, and nothing has been deployed.
- The first charge when the trial ends (about 3 December 2026), and any webhook events from that transition.
- Annual and Multi Outlet trial subscriptions end to end. Their plans passed validation, but only Single Outlet Monthly was subscribed.
- Cancelling during the trial in a PayPal account (it is mentioned in the FAQ copy and relies on standard PayPal behaviour, which was not exercised here).
- A real existing legacy subscription reconciling against the live Sandbox. This is covered by automated tests only.
- Production PayPal.
