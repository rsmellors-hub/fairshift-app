Working note from the build. It may describe an earlier state. The README and docs/SUBMISSION_EVIDENCE.md describe the submitted build.

# Owner onboarding and organisation entitlement

## Change and authority boundary

Baseline: `ccc08025f90d941b36d2dfe1bef10163acdfd96a`.

The prior request guard resolved active organisation membership but never consulted
subscription state. Creating an organisation therefore exposed the operational
Owner shell even when its subscription was `UNCONFIGURED`.

`src/server/billing/entitlement.ts` now supplies the single entitlement decision:
`ACTIVE`, a provider subscription ID, a plan ID, and a non-null authoritative
verification timestamp are all required. Missing records and all other states deny
operational access, including `APPROVED`. Configuration or browser navigation alone
never grants access.

`requireScope` resolves identity/membership/location as before, then checks this
persisted organisation entitlement. `requireMembershipScope` is deliberately limited
to onboarding/business editing and subscription setup/reconciliation. Invitation
redemption and identity/account recovery do not require a paid subscription.

## Customer flow

1. `/register`: title (Mr/Mrs/Ms/Dr/Other), first name, surname, position, telephone,
   canonical identity email and password. No role or organisation authority is accepted.
2. Existing verification flow → `/account` → `/onboarding`.
3. Set up workplace: business/trading name, business address, city/suburb,
   province/state, postal code, country, and first operating location.
4. One transaction persists the organisation, first location, Owner membership and
   `UNCONFIGURED` organisation subscription. It requires verified email and complete
   personal details. Failure rolls back the entire creation.
5. Restricted `/onboarding`: personal/business forms, persisted subscription status,
   PayPal setup/reconciliation, account/notifications and sign out. No operational
   sidebar is rendered. Existing Owners may complete missing details here; their
   operating location is displayed separately and cannot be edited with this form.
6. Complete personal/business details are required before provider subscription
   creation. Missing provider configuration leaves the organisation saved and locked.
7. PayPal approval → `/billing/return` → authoritative provider GET reconciliation.
   The return URL accepts no status/organisation claims from the browser. The existing
   subscription webhook also verifies authenticity and reconciles via provider GET.
8. Verified ACTIVE state enables “Continue to FairShift” and the normal Owner shell.

## Protected surfaces

| Surface | Policy |
| --- | --- |
| `/owner`, `/owner/{locations,forecast,reporting,workforce,policies,payments,settings}` | Owner membership + organisation entitlement, in layout and workspace loader |
| `/manager`, Plan/Team/Review and compatibility routes | Owner/Manager scope + same organisation entitlement |
| `/worker`, Shifts/Earnings/Profile and compatibility routes | Team Member scope + same organisation entitlement |
| `operations-actions.ts` | Every exported operational mutation uses gated `requireScope` |
| `scheduling-actions.ts` | Scheduling, destination and incentive/payout entry points use gated `requireScope`/`demoAuthority`; existing payout authority unchanged |
| Invitation create/resend/revoke actions | Gated request scope; domain service also rechecks entitlement |
| Worker workspace/response/destination service | Entitlement required; existing worker/organisation/location isolation retained |
| Account, verification, password reset, invitation redemption, sign out | Available independently of entitlement; existing identity/token controls retained |
| Owner subscription setup/reconciliation and business editing | Validated Owner membership without entitlement, preventing a billing recovery deadlock |
| PayPal order/capture APIs | Remain verified platform-operator-only, inaccessible to ordinary Owner/Manager/Worker identities |
| Subscription/payout webhooks and notification dispatcher API | Existing signature/secret and idempotency controls remain independent of commercial entitlement; activation callbacks must work while pending |
| Platform Operator | Separate existing operator authorization; no commercial role bypass added |

Owners without entitlement redirect to `/onboarding`. Managers and Team Members
redirect to `/account?status=subscription-required`. Existing invitations may still
be redeemed while the organisation is non-entitled; operational access remains
locked afterward. Membership selection cannot unlock another organisation.
Notifications remain readable and identity recovery remains available. No existing
acceptance, allocation, payment, invitation, or notification record is invalidated
or deleted by the commercial gate.

## Migration 0008

`0008_owner_onboarding.sql` adds five nullable personal fields to `auth_users` and five
nullable address fields to `organisations`. A nullable title CHECK accepts only the
five supported values. Existing `name` fields remain display/trading names; identity
email remains the unique login email. No second credential email is added.

Applied migrations 0000–0007 are unchanged. Existing rows acquire nulls, with no
invented names, address or entitlement backfill. Existing FairShift Demo and its
UNCONFIGURED subscription remain intact and locked until authoritative activation.
Existing active organisations retain their verified entitlement; no new completion
requirement is retroactively imposed on an already-active subscription. Existing
Owners can complete their profile/business information without creating a replacement
organisation. The established first-location timezone default is unchanged.

Apply 0008 through the established migration runner in an explicitly authorised
future hosted step **before deploying this schema-dependent application change**.
No hosted migration, seeding, deployment or external provider request is part of
this implementation package.

## PayPal and operational preservation

The existing Sandbox-only adapter, stable create request IDs, identity/plan matching,
GET reconciliation, signed webhook verification, event deduplication, cancellation/
suspension/expiry mapping and payout webhook remain intact. The cancellation URL
now returns to `/onboarding?billing=cancelled`. No new subscription is automatically
created for a terminal subscription; recovery exposes reconciliation and support
copy instead. No plan, price, renewal, grace period or payment authority is invented.

Entitlement uses the last persisted authoritative state. Freshness/periodic
reconciliation is unchanged; timely cancellation/suspension updates depend on the
existing subscription webhook or explicit Owner reconciliation. There is no invented
local billing grace period or expiry rule.

Full external Sandbox flow still requires a valid `PAYPAL_SUBSCRIPTION_PLAN_ID` and
separate `PAYPAL_SUBSCRIPTION_WEBHOOK_ID`, alongside the established Sandbox credentials
and valid application origin. Runtime adapter configuration is checked without
revealing values. Hosted configuration was not inspected or changed in this package;
missing variables must not be assumed configured. The worker/payout webhook must
not be repurposed. No PayPal or email delivery was externally verified here.

## Verification evidence

Targeted tests use PGlite and controlled provider adapters, never hosted databases.
Coverage includes required fields, canonical email preservation, distinct business/
location data, verified Owner bootstrap, rollback on location failure, historical
upgrade, blank migration, non-entitled states, direct routes, real server actions,
ordinary-Owner denial at the platform API, Manager/Worker access, invitation redemption
while suspended, subscription reconciliation/webhook activation/revocation and
idempotency. Existing auth, work-term, notification and payout regressions are retained.

### Executed verification

All commands ran locally; none used hosted credentials or provider services.

```sh
pnpm test --maxWorkers=1 --no-file-parallelism tests/integration/owner-onboarding.test.ts tests/integration/auth-request.test.ts tests/integration/migration.test.ts tests/integration/subscriptions.test.ts tests/integration/auth-tenancy.test.ts tests/integration/product-workspaces.test.ts tests/unit/transactional-adapters.test.ts
pnpm test --maxWorkers=1 --no-file-parallelism
pnpm typecheck
pnpm lint
DATABASE_URL=postgresql://localhost/fairshift pnpm build
DATABASE_URL=postgresql://localhost/fairshift pnpm db:generate
git diff --check
```

| Check | Executed result |
| --- | --- |
| Focused tests | PASS — 7 files / 43 tests |
| Full serialized suite | PASS — 24 files / 159 tests (baseline 140 tests retained, 19 added) |
| Typecheck | PASS |
| Lint | PASS |
| Production build | PASS — Next.js 16.4.0 Webpack; 13 static pages, dynamic onboarding route |
| Schema drift | PASS — no schema changes remaining after generating 0008 |
| Diff whitespace | PASS |
| Blank migration through 0008 | PASS — nine journal entries, nullable fields, title constraint |
| Historical 0007 → 0008 | PASS — identity, organisation, location, membership and subscription preserved |

The initial full run found two positive operational fixtures still using
UNCONFIGURED subscriptions. Those fixtures now explicitly initialise verified
ACTIVE test subscriptions; negative entitlement tests continue to exercise the real
authorization guard. The subsequent focused and full runs above passed.

### Remaining external verification

No hosted environment inspection/change, migration, deployment, email, PayPal call,
financial action, commit or push was performed. Review the new migration and code;
then separately authorise the hosted migration and deployment. After subscription
configuration is confirmed, manually verify the existing UNCONFIGURED Owner is
restricted, completes the missing details, approves a Sandbox subscription, remains
locked until authoritative confirmation, and then opens the operational workspace.
Verify cancellation/suspension restores the gate and that pending invitations can
still be redeemed. No cancelled-subscription replacement billing flow is introduced.

