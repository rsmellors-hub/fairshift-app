Working note from the build. It may describe an earlier state. The README and docs/SUBMISSION_EVIDENCE.md describe the submitted build.

# Pay Agent foundation evidence

| Item | Value |
|---|---|
| Package | FS-HACK-SA-PAY-AGENT-FOUNDATION-001; Owner instruction, 5 November 2026 |
| Latest corrective package | FS-HACK-SA-PAY-AGENT-CORRECT-001, Owner instruction, 5 November 2026; correction and journal recovery inventory below |
| Classification | SUBMISSION-CRITICAL; SA roadmap section 2 steps 9–11 foundation only |
| Checkout | `../pay-agent-worktree`, branch `fs-hack-sa-pay-agent-001` |
| Exact base | `789be8d9c0cb6c810452191609a25d65d6f01fa2` |
| Authority | Approved `../sa-roadmap-worktree/docs/FS-HACK-SA-ROADMAP-001.md` section 2 and `FS-HACK-SA-AMENDMENT-001.md`, DEC-SA-011; read without modification |
| Status | Isolated implementation; execution disabled. No production route/event registration, database adapter, migration, provider client factory or settlement implementation |
| External verification | NOT VERIFIED: genuine Pay Agent model invocation, provider operation, browser/hosted automatic settlement and SA Golden Path |

## Preflight and boundaries

The requested branch/path were unused. The new branch/worktree was created at the exact requested base, initially clean. The canonical checkout was on `fs-square-live-001`, HEAD `822c5fdf53fd330b5f98845141a157dab6e3c9ad`, with existing `next-env.d.ts` and `.claude/` changes; these were preserved. The governance worktree contained uncommitted SA decisions and the ZAR currency/payout guard; it was read only. No changes from it were copied or integrated.

Expected → DEC-SA-011 automatic settlement needs an authenticated service boundary over preauthorised accepted terms and manager-confirmed work.

Found → The base shared engine (`src/server/payments/work-payouts.ts`) requires an Owner/Manager human scope and `APPROVED` payable. `confirmWork` persists confirmation/base payable but does not emit a durable Pay Agent event. Current funding uses global credentials without a tenant merchant binding. The stricter GBP/USD evidence-based currency gate exists only in the uncommitted governance worktree; this base's formatter alone does not reject ZAR.

Impact → A production event adapter cannot safely call the current manual approval/payout entry points as a service, impersonate a manager, or assume an SA funding/currency route. The completed-work authority projection, durable event/journal adapters and service settlement contract are missing. SA-G1/3/4/5 are not established by this foundation.

Recommended action → Keep execution disabled as the package directs. A separately authorised integration package must supply the missing contracts using the existing engine, preserving payout uniqueness, financial integrity and recovery. No automatic approval or provider bypass was implemented here.

## Files and contracts

- `src/server/pay-agent/contract.ts`: strict event, identity, evidence and action schemas; typed `ready`, `blocked`, `processing`, `uncertain`, `completed`; durable journal, verifier, evidence reader and missing shared-settlement interface.
- `src/server/pay-agent/policy.ts`: deterministic readiness/refusal/status explanations with persisted evidence references. Checks readiness only; does not calculate, approve, reserve, send or reconcile money.
- `src/server/pay-agent/orchestrator.ts`: authenticated completion-event consumer with allowlisted action validation, durable attempt claim, post-model evidence recheck, deterministic refusal and safe exception handling. Execution is hard disabled with no configurable executor.
- `tests/unit/pay-agent.test.ts`: synthetic server evidence, test-only Map journal and mocked HTTP; no database/provider operation.
- `docs/FS-DOCUMENT-AUTHORITY-REGISTER.md`: this checkout's package pointer only. Its older baseline remains historical; current SA authority was consulted in the governance worktree.

## Model integration and evidence limits

The module accepts the existing `StaffingAssessmentProvider` and calls its real `assess` interface. It reuses `OpenAiStaffingAssessmentProvider`'s Responses endpoint, strict JSON schema envelope, `store:false`, timeout/error/refusal handling and existing model configuration. No new model SDK, transport, credentials or provider client factory was added. Deployment wiring must inject an explicitly authorised existing provider. No model-name change is needed.

The strict response schema is an action proposal with exactly `action: "settle_confirmed_work"` and the one event-resolved `payableId`. The local dispatcher validates JSON and exact keys again, including payable binding. This uses Responses Structured Outputs, **not native function calling or PayPal Toolkit/MCP**. No tool loop, dynamic tool lookup, URL dispatch or arbitrary provider operation exists. A valid action ends at `EXECUTION_DISABLED`.

Only payable ID, trigger kind, version and evidence references enter the model input. Amount, currency, recipient, merchant, funding identity, raw provider payloads, credentials and arbitrary worker/manager prose do not. References are data, not instructions. No model explanation becomes financial evidence. The journal receives configured/returned model and response ID for a received response; no raw model text/error is stored. Deterministic application copy explains refusal and exceptions using evidence references.

**VERIFIED locally with mocked HTTP:** the existing Responses implementation receives the strict payable-bound schema and `store:false`, parses a synthetic action and refuses a synthetic provider refusal. These tests demonstrate integration wiring and local validation, not a genuine model-generated decision. **No genuine model call was attempted**, as provider calls were prohibited.

Official documentation consulted read-only: [Function calling and strict schema requirements](https://developers.openai.com/api/docs/guides/function-calling). No financial/provider eligibility claim relies on that documentation. The reused transport supplies the Responses Structured Outputs envelope.

## Event and settlement connection points

1. After the `confirmWork` transaction in `src/server/scheduling/operations.ts` commits, an integration must durably publish a manager-confirmed-work event linked to the allocated assignment and payable. Publication must be atomic with confirmation, or use a demonstrably reliable transactional outbox/replay design; calling the model inside the transaction is unsuitable. No worker payout request or second discretionary Owner approval is introduced.
2. Once deterministic performance/earnings are final, an authenticated server consumer calls `onConfirmedWork({ eventId }, opaqueCredential)`. The verifier must reject worker/human sessions and public demo personas and bind a service identity to tenant/location. None of these adapters is implemented here.
3. The evidence reader resolves and scopes the event, payable, linked preauthorisation, acceptance, completion, verified performance, payment authority, employer funding, worker destination and provider eligibility. A nonempty reference is a trusted-reader attestation of the underlying verified linked record, not proof by itself. The reader must not project a pending/manual payable as authorised without the revised deterministic authority contract. All changes, including payment status, affect its evidence version.
4. The journal atomically claims tenant/location/payable/version, independent of event ID. Repeats reuse the result; concurrent triggers report processing. Busy claims are never stolen. Model failures remain recorded and do not change obligations. Production needs durable storage, CAS ownership, explicit safe recovery/retry policy and scheduling for evidence that later becomes available. Never mutate financial evidence merely to force a new version/retry. No production journal or outbox exists in this package, and no migration was added.
5. A separate adapter must implement `ConfirmedWorkSettlement.settleConfirmedWork(identity, { payableId, expectedEvidenceVersion })` **using the existing shared engine**. It must atomically re-resolve/revalidate financial facts and authority at the existing unique payout reservation. Its command accepts no model/caller amount, currency, recipient or merchant. This interface is not injected or callable in this foundation.
6. Preserve `submitWorkPayout`'s persisted financial facts and reservation uniqueness, `payoutSenderIds`' original identities, and `refreshWorkPayout`'s reconciliation/recovery controls, including immutable first reservation time and the no-batch recovery ceiling. Do not manufacture a human role or auto-call `approveWorkPayable` as a shortcut. Provider client construction remains outside the Pay Agent.
7. Project the shared engine's persisted `SUBMITTING/PROCESSING` as processing, `RECONCILIATION_REQUIRED` as uncertain, and only authoritative `PAID` as completed. Failed and NOT_SENT payouts are blocked here and left to the existing recovery path. Batch success is never treated as item success by this module. `ready` means preflight readiness only, not payment authorisation. Every result reports `executionEnabled:false`.

## Activation prerequisites

- Separately authorised integration and applicable SA-G1/3/4 dependencies; independent tenant onboarding, public-demo isolation and an authenticated rehearsal context.
- Linked preauthorised accepted compensation, manager-confirmed completion, verified performance and deterministic entitlement/authority contract, without a second discretionary casual payment approval. Missing/unapproved tips remain ineligible. No permanent-staff release path is implemented; its access/ceiling/allocation policies remain gated.
- Tenant-bound merchant/environment/funding and worker destination/eligibility, pinned to original reservations for recovery. Global demo credentials are insufficient for ordinary employers.
- Verified SA sender/recipient/category/provider currency and any Owner-approved ZAR conversion, fee and rounding policy. This foundation refuses ZAR even if the reader asserts route eligibility, permits no conversion or currency fallback, and also requires route-specific evidence for historical GBP/USD currencies. Historical currency evidence alone never grants tenant eligibility.
- Durable completion event/outbox, scoped resolver, authenticated service verifier, atomic journal and explicit failure/retry/recovery policy, plus integration into the one existing settlement engine.
- Separately authorised genuine model/provider exercises and integrated positive/negative acceptance. A model error never pays or erases an obligation. No local status here establishes provider success.

## Original foundation verification — historical checkpoint

- Focused Pay Agent tests: final run **74/74 PASS**, mocked model/HTTP only. Covers financial/tool tampering, wrong payable/action, caller manipulation, service/tenant/location isolation, missing evidence, unsupported currency including ZAR, repeated and concurrent triggers, safe failure/replay, journal failure, changed evidence and truthful existing settlement states.
- Typecheck: **PASS**, final `tsc --noEmit`, exit 0. An initial run read the earlier three-argument test-journal signature and reported TS2493; the final test double matches the four-argument interface, including model evidence.
- Repository-wide lint: **PASS**, `eslint .`, exit 0. Affected-file lint repeated after the final evidence-consistency guard: **PASS**, exit 0.
- Production build: **PASS**, `next build --webpack`, exit 0, including compilation, TypeScript, 15 static pages, optimisation and traces. Ran with `env -i`, pinned Node, no environment files/provider keys, dummy loopback database URL and an HTTP/fetch blocker. No network blocker fired or provider request occurred.
- Git whitespace check: **PASS**, `git diff --check`. Existing payout service, OpenAI transport, application routes and migrations are unchanged.
- No full integration suite: production settlement/routes/schema are untouched; the selected checks cover the new isolated module and existing Responses transport.

## Original foundation final checkpoint — historical

All required local checks completed successfully. Branch remains `fs-hack-sa-pay-agent-001`, HEAD remains exact base `789be8d9c0cb6c810452191609a25d65d6f01fa2`. Six intended files: three new module files, one new test file, one new evidence document and the modified local authority-register pointer. Nothing staged or committed. The temporary dependency symlink was removed; build/typecheck output is ignored. Canonical and governance worktrees were not written by this package.

Reproduce with pinned `/Users/ryanmellors/.nvm/versions/node/v24.22.0/bin/node` and an available local dependency installation (the run temporarily linked the canonical `node_modules`; no dependency install or network fetch):

```sh
node node_modules/vitest/vitest.mjs run tests/unit/pay-agent.test.ts
node node_modules/typescript/bin/tsc --noEmit
node node_modules/eslint/bin/eslint.js .
node node_modules/eslint/bin/eslint.js src/server/pay-agent tests/unit/pay-agent.test.ts
```

The build used `node node_modules/next/dist/bin/next build --webpack` with the isolated environment and blocker described above; do not copy shared environment secrets for reproduction. **No genuine model/payment provider API calls, real payments, commit, merge, push or deployment occurred. Real payments executed: NO.**


## Corrective implementation — FS-HACK-SA-PAY-AGENT-CORRECT-001

**Authority and scope:** Owner-authorised bounded correction, 5 November 2026; DEC-SA-011 and SA roadmap section 2 steps 9–11. Current SA governance was read from `../sa-roadmap-worktree`, including the SA route closeout. No other worktree was modified. The existing authority-register file is deliberately preserved byte-for-byte as the package directs; this evidence section records the corrective package without replacing current SA governance.

### Preflight and independent finding

Verified worktree `../pay-agent-worktree`, branch `fs-hack-sa-pay-agent-001`, exact HEAD `789be8d9c0cb6c810452191609a25d65d6f01fa2`; all six inherited files matched the independent review's content manifest SHA-256 `1bb7e7f84c8b2ce596ca022b5641287a9f03f9d13397ebe44d9571838d0df4a8`. The five new files and modified register were unstaged and uncommitted and were preserved. Canonical-versus-integration HEAD differences do not change this package's explicit baseline.

The read-only review FS-HACK-SA-PAY-AGENT-REVIEW-001 independently reproduced an incorrect post-model result: a reader projection with the original event/tenant/location but another payable already PAID returned `PAYOUT_COMPLETED` before the original binding was checked. It also identified cached transient failures and missing original merchant/environment binding as activation gaps.

**Reproduced locally before the fix:** the expanded regression run exited 1 with **19 failures and 81 passes (100 tests)**. Another payable's PAID produced `completed/PAYOUT_COMPLETED`, PROCESSING produced `processing/PAYOUT_PROCESSING`, and FAILED produced `blocked/PAYOUT_FAILED` rather than a binding refusal. Further failures demonstrated acceptance of changed authority references and financial facts when the refreshed projection was PAID. All data was synthetic, and the tests blocked global fetch. No provider or settlement operation occurred.

### Exact correction and compatibility

`matchesOriginalBinding` now runs before any refreshed payout status is evaluated. It compares every validated authoritative field: completion event/type, organisation, location, payable, references, server-resolved amount/currency/recipient/merchant and the required entitlement version. Scope/event mismatches are rejected by the scoped read as `UNAUTHORISED`; other binding mismatches become `blocked/EVIDENCE_CHANGED`. Malformed evidence is `EVIDENCE_INVALID`; read failure remains `uncertain/EVIDENCE_UNAVAILABLE`. A binding refusal uses the original invocation's evidence references, never the substituted payout's reference.

The original single evidence version covered both authority and payout observations, which could not safely distinguish concurrent completion from entitlement substitution. The isolated reader contract now requires **`entitlementVersion`** for all authority/financial/eligibility changes, including underlying inputs not visible in the projection. Existing **`version`** covers those changes plus the projected payout observation. Both are opaque server-resolved values; neither comes from the caller or model.

A refreshed projection must retain the exact original entitlement version and complete authoritative binding. Its full version may differ only when the payout projection differs; conversely, a changed payout projection must advance the full version. Thus a legitimate same-payable, same-entitlement concurrent PAID update can be reported as completed. An unexplained full-version change, changed entitlement version, or an unversioned payout update is refused before status handling. A future reader must implement these version semantics; old projections missing `entitlementVersion` fail closed. No production reader exists or was changed here.

The journal claim now also receives the immutable original event ID, entitlement version and full evidence fingerprint. Its unique deduplication key remains tenant/location/payable/full evidence version. The eventual durable adapter must store the binding on the first claim and must not replace it on duplicate delivery. Refusals are finished as blocked results against the original key/attempt; they are never journalled as payment completion. No original financial record is changed. Test-double journal storage is synthetic only.

No settlement executor, application route, payment provider client, migration, payout service change or production retry was added. The allowlisted action remains `settle_confirmed_work(payableId)`. No worker payout request or second discretionary casual approval was introduced. Permanent-staff release access remains outside this package.

### Durable journal recovery inventory — UNRESOLVED, execution disabled

- **Cached model/read failures:** `MODEL_FAILED` is persisted as a finished result; repeat claims return it for the same key. A transient post-model read failure is likewise cached even after reads recover. This preserves the financial obligation and avoids uncontrolled repeats, but does not provide retry progress. Current `MODEL_FAILED` collapses failure categories, so the eventual adapter also needs a persisted safe failure classification and dispatch phase to distinguish retryable network/timeout/rate-limit failures from refusal, malformed output and policy denial. Do not store raw model/error text.
- **Unfinished claims:** a crash after claim, or a failed/uncertain `finish`, can leave the claim busy. Current code never steals it or assumes elapsed time proves no payment occurred. A restarted process must read durable state, not recreate an empty in-memory journal.
- **Minimum future transition:** the type-only `PayAgentJournalRecovery.claimRetry(identity, { key, originalBinding, expectedAttemptId, expectedJournalRevision })` describes atomic acquisition of a fresh attempt owner for the SAME obligation after deterministic eligibility checks. Results distinguish claimed, wait-until-backoff, reconciliation-required, binding-changed, CAS-conflict and non-retryable. The interface is neither implemented, injected nor invoked by the orchestrator.
- **CAS and fencing:** compare the persisted original attempt, journal revision, immutable key and original binding; re-read the current entitlement and shared payout state. A successful retry acquisition must atomically fence the prior owner, retain attempt history and issue a new attempt ID/revision. A late result from the old process must fail its ownership check. Do not delete/reset the original attempt, payable, reservation, sender IDs or provider evidence.
- **Eligibility/backoff:** only classified transient pre-settlement failures with a proven absence of financial dispatch may enter a model retry. The authenticated server must enforce a persisted not-before time, attempt/time limits, current authority and current route eligibility. Exact retry/backoff values and terminal handling need the integration package; none are invented or enabled here. A refusal or changed binding is not a blind-retry instruction.
- **Crashes/restarts:** durable attempt/phase records must distinguish interruption before settlement from a dispatch that may have happened. A lost commit acknowledgement requires re-reading storage before another claim. Unknown dispatch must go to shared settlement reconciliation even if an orchestration lease expires. Expiry alone is never permission to resend money.
- **Binding preservation:** retries retain original payable, tenant/location, completion event, entitlement version and evidence fingerprint. Values in a retry command are expected values for comparison, not replacement financial facts. Mismatch blocks retry. New legitimate financial evidence needs separate re-evaluation under its real version; never mutate a version merely to bypass a cached outcome.
- **Outbox replay:** a future completion transaction must durably record its event, then a server consumer may deliver it at least once after commit. Replay must find the existing payable/version journal record and original binding. A duplicate event ID or a second notification for that same payable must not replace the stored first-claim binding. Durable replay coordinates with the atomic retry transition; process restart must not create another payout or reset provider identifiers.

| Persisted settlement state | Recovery requirement before any future action |
|---|---|
| NONE, proven no dispatch | Only an eligible, fenced, policy-controlled model retry; settlement still needs all external/financial gates |
| SUBMITTING or PROCESSING | Observe/reconcile the original payout; no new agent submission |
| RECONCILIATION_REQUIRED or unknown dispatch/commit | Reconcile through the original authorised merchant/environment; no blind resubmission |
| Known provider batch | Preserve the existing authorised GET reconciliation path, including for older batches |
| No batch with an uncertain create | Only the existing engine's controlled recovery with original sender IDs/facts, immutable first reservation time, recovery ceiling and current route gates; never a generic journal retry |
| NOT_SENT | Existing engine recovery rules and route eligibility; the agent does not authorise an automatic resend |
| FAILED, returned or reversed | Truthful status and controlled investigation/recovery; no generic resubmission from this foundation |
| PAID | History/status only; no new settlement |

Original merchant/environment binding remains unresolved in the shared reservation/adapter. Existing `refreshWorkPayout` and its recovery ceiling are untouched. Current SA governance separately refuses ZAR and legacy GBP/USD SA routes before a create/resend while retaining known-batch status reads; this foundation must not be used to bypass those controls. A future settlement result should also distinguish pre-reservation refusal without inventing a payout reference; the existing placeholder settlement interface still needs that refinement before activation.

### Corrective verification and release assessment

**VERIFIED locally:** the final combined targeted run exited 0: **184 tests passed across 5 files**, in 261.33 seconds. This includes the corrected Pay Agent suite and four existing AI orchestration/contract suites. The initial reproduction run above intentionally failed against the original code. An intermediate corrective run had 108 passes and one old assertion expecting `CURRENCY_UNSUPPORTED` for a mid-invocation currency substitution; that assertion was updated to require the stronger binding-first `EVIDENCE_CHANGED` refusal. The original pre-model ZAR refusal tests remain unchanged in expected behavior and pass.

```sh
node node_modules/vitest/vitest.mjs run tests/unit/pay-agent.test.ts tests/unit/ai-staffing-contract.test.ts tests/unit/demand-context.test.ts tests/integration/ai-staffing.test.ts tests/integration/demand-context.test.ts --reporter=dot
node node_modules/typescript/bin/tsc --noEmit
node node_modules/eslint/bin/eslint.js .
```

All commands used pinned Node `/Users/ryanmellors/.nvm/versions/node/v24.22.0/bin/node` and existing local dependencies. Providers were mocked. The Pay Agent suite installs a failing global fetch guard and verifies it was never called; the transport tests use explicitly injected mock HTTP instead. The temporary local dependency symlink was removed after verification. No full suite was run: the selected existing suites exercise the reused Responses transport, strict output validation, failed model attempts, persisted orchestration and stale evidence without changing settlement code.

| Check | Actual result |
|---|---|
| Pay Agent plus relevant existing orchestration tests | PASS, 184 tests / 5 files, exit 0 |
| Typecheck | PASS, exit 0 |
| Repository-wide lint | PASS, exit 0 |
| Isolated production build | PASS, exit 0: compilation, TypeScript, 15 static pages, optimisation and traces |
| Build isolation | Empty environment, no environment files/provider keys, dummy loopback database URL, telemetry disabled and fetch/HTTP blocker; no blocker fired |
| Git whitespace check | PASS, `git diff --check` |
| Preserved register | SHA-256 remains `9d4b35422babf4affefa1c5da47671333d8e035c662cde8dc7def9c9d7b25104` |
| Protected implementation | No changes to routes, `work-payouts.ts`, schema or migrations; `policy.ts` also preserved |

Regression coverage includes substituted payable states NONE, SUBMITTING, PROCESSING, RECONCILIATION_REQUIRED, PAID, FAILED and NOT_SENT; changed organisation/location/event; changed evidence references and financial identities/values; changed entitlement/full versions; malformed BLOCKED projection; legitimate same-entitlement concurrent completion and other versioned settlement observations; refreshed-reader failure and cached uncertainty; original ZAR refusal; financial-argument injection; refusal reason, original journal ownership/result and entitlement preservation. A failed binding is never journalled as completed, and another payable's payout reference is never attached to that refusal.

**Foundation integration assessment: GO for the corrected, execution-disabled foundation only.** This is a technical assessment, not permission to commit, merge, deploy or activate. The eventual integration must selectively reconcile the inherited register edits with current SA governance, preserve the two-version/binding contract and keep external/financial gates closed until separately verified.

**Payment activation assessment: NO-GO.** Genuine OpenAI execution remains **NOT VERIFIED**; original merchant/environment binding, durable journal retry/CAS storage, outbox/service identity/evidence adapters, deterministic completion authority and SA provider eligibility remain unresolved. Combined integration/browser/hosted acceptance is **NOT VERIFIED**. The placeholder settlement result still needs a typed pre-reservation refusal without a fabricated payout reference. No production retries are enabled.

Final state: branch `fs-hack-sa-pay-agent-001`, HEAD `789be8d9c0cb6c810452191609a25d65d6f01fa2`. The inherited six-file inventory is retained, entirely unstaged/uncommitted. This corrective package changed only `contract.ts`, `orchestrator.ts`, `tests/unit/pay-agent.test.ts` and this evidence document; `policy.ts` and the inherited authority-register entry are preserved byte-for-byte. No other worktree was written. **No genuine model or payment provider call, payment, commit, merge, push or deployment occurred. Real payments executed: NO.**
