# FS-HACK-SAAS-ISOLATION-CLOSE-001

Date: 5 November 2026. Scope: SUBMISSION-CRITICAL security blocker repair for PayPal payment operations (roadmap section 15, step 13), including related subscription and webhook state. This record does not authorise a successor package or deployment.

## Baseline and preservation

VERIFIED: worktree `../saas-safety-worktree`, branch `fs-hack-saas-safety-001`, HEAD `789be8d9c0cb6c810452191609a25d65d6f01fa2`. The working directory, branch, full HEAD, status, worktree inventory, existing diffs, current AGENTS.md, and authority-register sections 1–2 were inspected. The Owner's current work package supplies authority; no product or merchant-ownership decision was made.

There were 34 modified tracked files, two untracked evidence/test files, and no staged changes at entry. Their contents and hashes were preserved in `/private/tmp/fairshift-isolation-baseline` before implementation. All 35 pre-existing application/test/evidence files remain byte-identical. Only the authority-register pointer was extended to record this package; its prior remediation checkpoint remains. The earlier remediation evidence is unchanged.

## Server boundary and configuration

`src/server/config/deployment.ts` owns the boundary:

- `FAIRSHIFT_DEPLOYMENT_MODE=LIVE_CUSTOMER`: all existing Sandbox PayPal factories, provider actions and financial reconciliation are refused. Missing, misspelled or unrecognised values take this same closed path. `NODE_ENV`, public-demo flags, request headers, query parameters, form fields and JSON bodies cannot choose deployment purpose.
- `FAIRSHIFT_DEPLOYMENT_MODE=HOSTED_SANDBOX_DEMO` also requires `FAIRSHIFT_SANDBOX_ORGANISATION_ID` to be a valid UUID. It identifies the single organisation permitted to use these Sandbox integrations. Existing credentials, plan mappings and listener validation remain required. Either PayPal environment setting, when present, must be exactly `sandbox`; conflicting values are refused rather than silently converted.
- Authenticated financial scopes must match that server-owned organisation. Public demo persona scopes cannot send or refresh provider payments. Normal server-side roles, memberships, verified identity, outlet/worker restrictions, approved-payable checks and financial-continuity access remain in force.
- The historical operator order/capture experiment and its webhook are additionally restricted to the existing fixed demo organisation. Operators retain their allowlist and same-origin checks. A public demo session is refused even if operator allowlisting overlaps.
- Controlled judge access uses ordinary authenticated accounts in the configured isolated organisation. Public demo sessions retain their existing permitted planning interactions and remain closed to provider writes. Subscription checkout requires an existing verified Owner in that organisation before acquisition can create a subscription row.

No deployment environment or hosted configuration was changed by this package. A separately provisioned Sandbox deployment must use its own database and Sandbox credentials; this package does not establish that physical infrastructure separation.

## Audited paths and rejection order

| Surface | Control |
|---|---|
| `POST /api/paypal/orders` | Authenticated non-public operator, deployment and fixed organisation checked before client construction or pending-sale insertion |
| `POST /api/paypal/orders/[orderId]/capture` | Same gate before client construction, capture or reconciliation |
| `POST /api/webhooks/paypal` | Deployment and fixed organisation checked before client construction, inbox persistence or capture reconciliation |
| `POST /api/webhooks/paypal-subscriptions` | Deployment checked before adapter construction; subscription's stored organisation checked before reconciliation or event mutation |
| `sendPayoutAction`, `refreshPayoutAction` | Authenticated financial scope, deployment, tenant and public-persona refusal before factory or payout service |
| `submitWorkPayout`, `refreshWorkPayout` | Same deployment/tenant/persona guard before financial reads, reservation, recovery, provider calls or audit/state updates, including injected adapters |
| Subscription checkout/status actions and services | Deployment/tenant guard before adapter construction and financial mutation; authoritative provider reconciliation and listener binding retained |
| `/subscribe` | Saved Sandbox approval links and adapter availability require the matching isolated organisation |
| Historical order, reconciliation and incentive services | Existing fixed identity confined to its configured Sandbox organisation; legacy customer payout actions remain unavailable |
| PayPal factories and configuration status | Factories reject before constructing clients; blocked Sandbox configuration is not advertised as available |

No live endpoint was added. No Sandbox request is translated into a live request. No schema, migration, amount, recipient, commercial plan, payout status mapping, idempotency key or recovery-window rule changed.

## Recovery and existing remediation

REPOSITORY EVIDENCE: financial service changes are early guards only. The immutable original payout reservation time, 28-day no-batch cutoff, uncertain-outcome handling, identical sender IDs/amount/currency/recipient on safe recovery, concurrent claim protection, known-batch GET reconciliation and item-level SUCCESS requirement are retained. Approval remains a separate deterministic action and does not send money.

The previous explicit tenant scopes and synthetic-history authority controls were preserved. Existing calculation/regression fixtures now explicitly configure a disposable isolated Sandbox organisation where they exercise provider behavior. New boundary tests use the real deployment parser; no production exception or test-only branch was added to application code.

## Verification

Completed checks so far:

- Initial focused authority/HTTP/action/recovery run: 39/39 tests in three files passed.
- Final authority/HTTP/action/capture and subscription-journey run: 31/31 tests in three files passed, with external fetch blocked.
- Final repository-wide ESLint: passed, no warnings.
- Final standalone TypeScript (`tsc --noEmit --incremental false`), after build completion: passed.
- Final isolated production build: passed compilation, TypeScript, static generation and traces.
- Whitespace/diff check: passed.
- Final fresh-process full suite: **1008/1008 passed in 76 files**, exit 0, 1359.25 seconds. All 295 code/configuration-file hashes recorded at the start remained unchanged throughout this run. This is the final automated acceptance checkpoint.
- The full run also exposed one stale authenticated-boundary assertion: it expected a generic error where live payout actions now return the specific isolation refusal. The assertion now requires that refusal; all 11 authenticated-boundary tests passed on rerun (52.976 seconds).
- The full run exposed 22 failures in `demo-access.test.ts`: its preparation of fake paid history did not configure the new isolated Sandbox authority. The setup now explicitly configures its organisation before the fake payout; no application guard or assertion was weakened. All 24 tests in that file passed on rerun (87.708 seconds), including public-demo provider refusal, real session/tenant boundaries and preservation of prepared payment evidence.

An earlier build caught a nullable identifier in the newly added fake capture response; the fixture was corrected to its non-null internal reference. A standalone typecheck run overlapped Next's regeneration of `.next/types` and reported missing generated files; it was repeated successfully after the build finished. No application workaround was introduced for either result. All new provider responses are MOCKED. Tests use disposable PGlite databases; no configured application database or hosted database is used. The full suite and build run with an empty environment and external fetch blocked. The build uses no provider credentials and a non-running loopback database URL. No provider call is authorised or performed.

## Remaining gaps and claims limits

- Production PayPal processing and production merchant ownership remain unimplemented/unresolved. LIVE_CUSTOMER payment operations deliberately fail closed. This package does not change their financial contract.
- Hosted deployment configuration, physical database/credential separation, browser acceptance and genuine isolated-provider acceptance are NOT VERIFIED. No hosted operation, credential change or deployment was performed.
- Existing financial rows have no newly added environment discriminator. This package neither migrates nor reclassifies historical Sandbox subscription/payment records. Any previously mixed database requires an authorised release/data review before live use; stored entitlement semantics were not changed.
- Trusted deployment configuration must correctly identify deployment purpose and the permitted organisation. Browser input cannot grant that authority.

No commit, staging, merge, push, deployment, provider call or schema change.

## Files changed by this package

This list is relative to the preserved entry state; the earlier remediation diff is separate.

- `docs/FS-DOCUMENT-AUTHORITY-REGISTER.md`
- `docs/SAAS_ISOLATION_CLOSE_EVIDENCE.md`
- `src/app/api/paypal/orders/[orderId]/capture/route.ts`
- `src/app/api/paypal/orders/route.ts`
- `src/app/api/webhooks/paypal-subscriptions/route.ts`
- `src/app/api/webhooks/paypal/route.ts`
- `src/app/auth-actions.ts`
- `src/app/components/workspace-ui.tsx`
- `src/app/operations-actions.ts`
- `src/app/subscribe/page.tsx`
- `src/server/billing/paypal.ts`
- `src/server/billing/service.ts`
- `src/server/config/deployment.ts`
- `src/server/config/env.ts`
- `src/server/domain/transactions.ts`
- `src/server/incentives/demo.ts`
- `src/server/integrations/paypal/factory.ts`
- `src/server/integrations/paypal/webhook.ts`
- `src/server/payments/work-payouts.ts`
- `tests/helpers/sandbox.ts`
- `tests/integration/auth-request.test.ts`
- `tests/integration/database.test.ts`
- `tests/integration/demo-access.test.ts`
- `tests/integration/incentive-payout.test.ts`
- `tests/integration/onboarding-journey.test.ts`
- `tests/integration/opportunity-journey.test.ts`
- `tests/integration/owner-onboarding.test.ts`
- `tests/integration/paypal-final.test.ts`
- `tests/integration/performance-incentive.test.ts`
- `tests/integration/sandbox-isolation.test.ts`
- `tests/integration/subscription-webhook-route.test.ts`
- `tests/integration/subscriptions.test.ts`
- `tests/integration/webhook-route.test.ts`
- `tests/integration/webhook.test.ts`
- `tests/integration/work-payouts.test.ts`
- `tests/unit/deployment-isolation.test.ts`
- `tests/unit/work-payout-recovery.test.ts`

## Final complete-run history and verdict

The first complete run finished with **984 passed / 24 failed (1008 tests, 76 files, 2221.39 seconds)**. Twenty-two failures were the demo paid-history fixture missing explicit Sandbox deployment configuration; one was an authenticated-boundary assertion expecting generic feedback rather than the specific isolation refusal. Their corrected files passed 24/24 and 11/11 on rerun. The remaining tenant-checkout test failed in the run started before the final early Owner guard was added; that same test passed in the fresh focused run. Retention of the earlier application module is INFERENCE from the timing and differing result. Because source changed after the first run started, that run is not final acceptance evidence.

A new complete process ran after all source and test changes were settled: **1008/1008 tests in 76 files passed**, exit 0, 1359.25 seconds. All 295 source/configuration hashes match those recorded as the final run began; no code or test edits were made during this run. Final TypeScript, repository-wide lint, isolated production build and diff whitespace checks passed. Logs are retained locally under `/private/tmp/fairshift-isolation-*.log`.

**PASS — production/Sandbox financial-operation isolation, verified locally with MOCKED providers.** Live deployment refusal, no provider construction on rejection, no financial mutation, public-demo provider-write refusal, authorised isolated Sandbox usability, tenant boundaries and recovery/forecasting regressions are verified by executed tests. Hosted/browser/provider acceptance remains NOT VERIFIED; the remaining release gaps above are unchanged.

Final Git state: branch `fs-hack-saas-safety-001`, HEAD `789be8d9c0cb6c810452191609a25d65d6f01fa2`, uncommitted changes only, nothing staged. All 35 pre-existing application/test/evidence files are byte-identical; only their authority-register pointer was extended. The temporary dependency symlink was removed; ignored build output remains. No commit, merge, push, deployment, provider call or schema change.

Isolation-only review patch (relative to the preserved entry state): `/private/tmp/fairshift-saas-isolation-close.patch`.


## Controlled local-commit checkpoint — FS-HACK-SAAS-ISOLATION-COMMIT-001

Owner authority: the directly supplied work package FS-HACK-SAAS-ISOLATION-COMMIT-001 authorises one local commit of the two completed remediation packages, with message `fix(fairshift): isolate sandbox financial operations`. This section, the authority-register pointer and removal of one trailing blank line from the earlier remediation evidence are the only documentation updates made during commit preparation. All preceding no-commit/status statements describe their original implementation checkpoints. The local contribution's exact SHA is the commit containing this section; it is reported after commit creation, rather than embedding a self-referential SHA.

VERIFIED preflight: source worktree `../saas-safety-worktree`, branch `fs-hack-saas-safety-001`, pre-commit HEAD `789be8d9c0cb6c810452191609a25d65d6f01fa2`. Current AGENTS.md, authority-register sections 1–2, both remediation evidence records and the authoritative FS-HACK-SA-ROADMAP-001 plus its dated amendment in `../sa-roadmap-worktree` were read. The actual inventory is **72 files: 65 modified tracked files and 7 new files**. It exactly equals the union of the two recorded package inventories. All 35 earlier application/test/evidence files matched the isolation package entry snapshot at preflight. The staged whitespace check then caught one redundant blank line at the end of the previously untracked remediation evidence; only that final blank line was removed. The other 34 files remain byte-identical. All 295 final-tested source/configuration hashes match; the two isolation documentation files also match the final review patch before these commit-specific additions. No unrelated concurrent edit or merge-conflict entry was found. No application, test, dependency, schema or payment-configuration change is introduced by this commit package.

Existing verification remains **1008/1008 tests in 76 files**, TypeScript, repository-wide lint and isolated production build PASS, using MOCKED providers and blocked external fetch. The retained final logs and the 295-file hash manifest were checked against current files. Those checks were not rerun for this metadata/documentation-only commit preparation; no new runtime or hosted proof is claimed. Staging must use the explicit inventory below, followed by full staged review, `git diff --cached --check`, exact index/content comparison and conflict/secret/generated-file checks before the single local commit. The final response reports their actual outcomes and final Git state.

The inspected invariants remain: live customer runtime refuses Sandbox financial actions before client construction or financial mutation; public demo personas cannot write to payment providers; server-configured authenticated isolated judge rehearsal retains bounded operation; browser input cannot choose the deployment profile; explicit tenant identity and demo-only synthetic histories remain enforced; payout reservations, original attempt time, recovery ceiling and provider-status truth remain intact. No live PayPal payment execution is enabled. This is a blocker repair supporting SA-R1 / steps 1–3 and the financial isolation prerequisites for steps 11–13; it does not establish SA-G1/3/4/5/6 acceptance or implement the corrected SA payment contract.

### Outstanding blockers — retained, not resolved

- **Tenant-specific merchant ownership and funding:** no ordinary employer may use shared demo credentials. The server-configured demo organisation is an isolation boundary, not a production merchant arrangement.
- **Immutable original-merchant/environment recovery:** sender IDs, amounts, currencies, recipients and original reservation times remain protected, but persisted original merchant/environment binding is not established. Deployment configuration must not be treated as that missing historical binding.
- **Historical Sandbox financial record separation:** no environment discriminator, migration or reclassification was added to old payment/subscription rows. Any potentially mixed database remains blocked for live use pending authorised review.
- **Real hosted-environment isolation verification:** deployment configuration, physical database/credential separation, browser acceptance and genuine isolated-provider acceptance are NOT VERIFIED.
- **SA merchant/payment-purpose/currency permission:** sender/recipient/category/provider-currency eligibility and any ZAR conversion/fee/rounding policy remain gated. UK/GBP and mocked evidence do not prove an SA route. This branch predates the separate SA governance/ZAR contribution; its refusal gates must be preserved on future integration.
- **Automatic completion-triggered settlement:** the corrected DEC-SA-011 path is not implemented here. The separately committed Pay Agent foundation remains execution-disabled, without an active completion consumer or shared-settlement executor. Existing manual approval/send behavior is historical implementation, not acceptance of the revised casual path.

**Checkpoint: NON-PAYMENT-READY.** Local code/test isolation PASS is not hosted isolation, SA funding permission, production payment capability or a completed Golden Path.

### Read-only integration assessment and recommended order

Integration was inspected read-only at **`7b801feb4f945235bd95344055ab354f1a31271c`** (`fs-hack-integrate-001`), clean. Its full tree is identical to the separate SA governance/ZAR contribution **`21a5d5e11ddac17fedaeb1e9e806fab141303720`**. Thus those governance/ZAR changes are already present; do not apply them a second time.

There are exactly six overlapping paths with `21a5d5e`:

- `docs/FS-DOCUMENT-AUTHORITY-REGISTER.md`
- `src/app/components/workspace-ui.tsx`
- `src/app/operations-actions.ts`
- `src/server/payments/work-payouts.ts`
- `tests/integration/work-payables.test.ts`
- `tests/integration/work-payouts.test.ts`

Both contributions are required. Preserve the SA roadmap/dated-decision authority and current integration history in the register. Keep both isolation and SA route/currency feedback. In payout actions retain this contribution's early deployment/tenant/persona guard **and** the SA contribution's lazy provider factory; in the shared payout service retain the early isolation guard, SA route/currency refusal before reservation/client construction, known-batch status reads, and the immutable no-batch recovery controls. Combine both regression additions and keep explicit tenant scopes. This is a future integration review requirement, not authorisation to edit or merge now.

The Pay Agent foundation **`1a3e2f23315e84693a394a3fc2c81aed35962360`** changes five separate files and has **zero path overlap** with this contribution. Its semantic dependencies still include tenant isolation, original merchant/environment binding, verified financial authority and route eligibility. Execution must remain disabled.

RECOMMENDATION, requiring a new Owner-authorised integration package: (1) retain the current SA governance/ZAR integration; (2) integrate this complete security contribution with explicit review of all six overlapping paths and combined isolation/SA/recovery/forecasting regressions plus normal verification; (3) integrate the Pay Agent foundation and verify it remains execution-disabled. Hosted/provider exercises and activation remain separately gated. No other worktree was modified and no merge, push, deployment, migration or provider operation is part of this package.

### Exact contribution inventory — 72 files

The inventory combines both authorised implementation packages; it is not the earlier 36-file remediation-only list or the 37-file isolation-only delta.

```text
docs/FS-DOCUMENT-AUTHORITY-REGISTER.md
docs/SAAS_ISOLATION_CLOSE_EVIDENCE.md
docs/SAAS_SAFETY_REMEDIATION_EVIDENCE.md
scripts/smoke-manager.ts
src/app/api/paypal/orders/[orderId]/capture/route.ts
src/app/api/paypal/orders/route.ts
src/app/api/webhooks/paypal-subscriptions/route.ts
src/app/api/webhooks/paypal/route.ts
src/app/auth-actions.ts
src/app/components/workspace-ui.tsx
src/app/manager/workspace.tsx
src/app/operations-actions.ts
src/app/operator/actions.ts
src/app/operator/workspace.tsx
src/app/owner/workspace.tsx
src/app/scheduling-actions.ts
src/app/subscribe/page.tsx
src/server/billing/paypal.ts
src/server/billing/service.ts
src/server/config/deployment.ts
src/server/config/env.ts
src/server/domain/transactions.ts
src/server/incentives/demo.ts
src/server/integrations/paypal/factory.ts
src/server/integrations/paypal/webhook.ts
src/server/intelligence/manager.ts
src/server/intelligence/sales-history.ts
src/server/intelligence/weekly.ts
src/server/payments/work-payouts.ts
src/server/product/owner-overview.ts
src/server/product/workspace.ts
src/server/scheduling/allocations.ts
src/server/scheduling/demo.ts
src/server/scheduling/operations.ts
tests/helpers/sandbox.ts
tests/helpers/workers.ts
tests/integration/ai-staffing.test.ts
tests/integration/allocation-scheduler.test.ts
tests/integration/auth-request.test.ts
tests/integration/commerce-independence.test.ts
tests/integration/database.test.ts
tests/integration/demand-context.test.ts
tests/integration/demo-access.test.ts
tests/integration/hospitality-policy-freeze.test.ts
tests/integration/incentive-payout.test.ts
tests/integration/manager.test.ts
tests/integration/onboarding-journey.test.ts
tests/integration/operations.test.ts
tests/integration/opportunity-journey.test.ts
tests/integration/owner-onboarding.test.ts
tests/integration/owner-overview.test.ts
tests/integration/owner-reference-pages.test.ts
tests/integration/paypal-final.test.ts
tests/integration/performance-incentive.test.ts
tests/integration/product-workspaces.test.ts
tests/integration/reference-history.test.ts
tests/integration/reference-refresh.test.ts
tests/integration/sandbox-isolation.test.ts
tests/integration/square-live.test.ts
tests/integration/staffing.test.ts
tests/integration/subscription-webhook-route.test.ts
tests/integration/subscriptions.test.ts
tests/integration/webhook-route.test.ts
tests/integration/webhook.test.ts
tests/integration/weekly-forecast.test.ts
tests/integration/work-payables.test.ts
tests/integration/work-payouts.test.ts
tests/integration/workload-opportunity.test.ts
tests/unit/deployment-isolation.test.ts
tests/unit/source-selection.test.ts
tests/unit/synthetic-history-authority.test.ts
tests/unit/work-payout-recovery.test.ts
```
