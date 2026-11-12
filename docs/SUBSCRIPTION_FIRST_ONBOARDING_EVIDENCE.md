Working note from the build. It may describe an earlier state. The README and docs/SUBMISSION_EVIDENCE.md describe the submitted build.

# Subscription-first Owner acquisition

## Implemented journey

Email/password registration → mandatory email verification → `/subscribe` → PayPal Sandbox approval → authoritative reconciliation → `/onboarding` → `/owner`.

Registration creates an identity and an opaque server session, without personal/business/location data or organisational authority. Verification retains that session when the verified identity matches the current browser session. Without a matching session, verification succeeds but password sign-in is required; the link does not create or switch a login session.

Selecting checkout creates/reuses an internal organisation shell, Owner membership and organisation subscription in one transaction under the identity row lock. The internal empty organisation name is displayed as “Workplace setup pending”; it is not a fabricated trading name. No location is required for billing. Existing Owner memberships, including previous incomplete organisations, are reused. The selected session membership is respected where it is an owned organisation.

After activation, one transaction validates and saves personal/business details, reuses an existing active location or creates the first, and records `setup_completed_at`. Existing values are prefilled. Identity email remains canonical and is never accepted as a profile update. Repeated setup does not create another organisation/membership/location.

## Commercial authority

`isEntitled` requires persisted ACTIVE status, provider subscription ID, provider plan ID and authoritative verification timestamp. `setup_completed_at` is a separate state. Operational guards require both commercial entitlement and completed setup for Owners, Managers and Team Members. Account recovery, authentication, notifications and invitation redemption remain accessible without operational entitlement.

The billing Owner scope does not require an operating location. Membership/verified-email authority is checked server-side. Direct operational routes/actions continue to use the gated `requireScope`; domain invitation/worker operations also require completed setup. Owner access is `/subscribe` while inactive and `/onboarding` while ACTIVE but incomplete. Manager/worker access is an account status screen until both gates pass.

Four independent provider mappings are selected server-side:

| Tier | Period | Variable | Active location limit |
|---|---|---|---|
| SINGLE_OUTLET | MONTHLY | PAYPAL_SINGLE_OUTLET_MONTHLY_PLAN_ID | 1 |
| SINGLE_OUTLET | ANNUAL | PAYPAL_SINGLE_OUTLET_ANNUAL_PLAN_ID | 1 |
| MULTI_OUTLET | MONTHLY | PAYPAL_MULTI_OUTLET_MONTHLY_PLAN_ID | 5 |
| MULTI_OUTLET | ANNUAL | PAYPAL_MULTI_OUTLET_ANNUAL_PLAN_ID | 5 |

No prices/discounts are defined by FairShift. Missing/invalid mappings disable checkout. Duplicate mappings fail closed. The old single `PAYPAL_SUBSCRIPTION_PLAN_ID` is no longer used for new checkout. Reconciliation/webhook verification do not require these new checkout mappings, preserving existing provider relationships.

Tier, period, limit and provider plan are persisted before provider creation. A pending attempt retains its request ID; another selection cannot replace that binding. Creation responses and browser query parameters cannot activate entitlement. Only authenticated PayPal authoritative GET reconciliation can update verified status, including during the verified, deduplicated webhook flow. Provider subscription/organisation/plan mismatches reject the update. Sandbox-only behavior and the separate payout webhook/financial authority remain intact.

Enterprise is contact only. `FAIRSHIFT_ENTERPRISE_CONTACT_EMAIL` optionally enables a mailto link; no automated enquiry email is sent. Without it the UI truthfully states online enquiries are unconfigured. Enterprise limits are explicit positive persisted values for separately agreed terms; no self-service provisioning/upgrade/proration is implemented.

## Locations

`createLocation` verifies current Owner authority, commercial entitlement and completed setup. First-location setup and subsequent creation lock the organisation row and count active locations before insertion. Single allows one, Multi five; Enterprise uses its stored limit. Checkout also refuses a tier smaller than existing active location usage. Inactive historical records do not consume active capacity. There is no new deactivation/reactivation workflow. Future activation mutations must use the same lock/capacity check.

Existing provider subscriptions with unknown tier retain their verified entitlement. Their tier/period/limit are not guessed. Additional locations are blocked with a configuration message until an explicitly reviewed commercial limit is assigned. Existing locations/history are never deleted or deactivated to fit a plan.

## Migration

`0009_subscription_first_plans.sql` follows 0008, adding:

- nullable `organisations.setup_completed_at`;
- `outlets.active` defaulting true, preserving all existing locations;
- nullable subscription tier, billing period and location limit with controlled-value/limit constraints.

Legacy workplaces are marked complete only when all prior business fields, an active location and a complete active Owner profile exist. Other records remain incomplete and can finish setup after activation. No provider tier is inferred or changed. Migrations 0000–0008 remain untouched. Apply 0009 before deploying this code. No hosted migration or provider configuration was performed.

## Verification

Local PGlite tests exercise blank migrations through 0009 and historical 0008→0009 upgrades, preserved business/payment facts, safe nullable commercial fields, completion backfill, and constraints. Integration tests cover real request/action gating, same-session verification continuation, cross-browser password fallback, minimal registration, setup rollback/repetition, all four checkout mappings, missing/duplicate configuration, provider plan substitution, Enterprise checkout rejection, Single/Multi limits and custom Enterprise limits. Existing authenticated tenancy, notification, work-term and payout regression tests remain included.

External status: provider calls in these tests are MOCKED. No hosted authentication, email delivery, PayPal checkout/activation or external migration was verified by this package. The four active Sandbox plans, settled commercial pricing, separate subscription webhook and runtime credentials must be configured/reviewed outside this package before a live golden-path rehearsal.

Executed local verification:

- `pnpm test --maxWorkers=1 --no-file-parallelism tests/integration/owner-onboarding.test.ts tests/integration/auth-request.test.ts tests/integration/auth-tenancy.test.ts tests/integration/subscriptions.test.ts tests/integration/migration.test.ts tests/unit/transactional-adapters.test.ts` — 6 files / 51 tests passed.
- `pnpm test --maxWorkers=1 --no-file-parallelism` — 24 files / 171 tests passed.
- `pnpm typecheck` — passed.
- `pnpm lint` — passed.
- `DATABASE_URL=postgresql://localhost/fairshift pnpm build` — production Webpack build passed, including `/subscribe`.
- `DATABASE_URL=postgresql://localhost/fairshift pnpm db:generate` — no schema changes / drift.
- `git diff --check` — passed.

The migration integration tests include both blank and historical upgrade rehearsals. No credentials were supplied to these PGlite tests. The build used the explicit localhost/test database URL above. No hosted state was touched. Changes are intentionally left uncommitted for review.
