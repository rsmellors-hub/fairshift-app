# FS-HACK-PAYOUT-RECOVERY-GUARD-001

Date: 5 November 2026. Owner-authorised P0 financial-integrity correction for roadmap steps 13–15. Local implementation and deterministic verification only. Provider integration in this verification: **MOCKED**.

## A. Verified repository baseline

**VERIFIED:** integration worktree `/Users/ryanmellors/Projects/Fairshift/integration-worktree`, branch `fs-hack-integrate-001`, full HEAD `36178784ba600c0b25132c8952a2bfa8fc638f72`, clean working tree and empty staging area. Both `e4279a7787c7ebe9078f202098c356367d0dcfc8` (Bryntum) and `bdc8e8e0ee43b8c1555908587109fbb5a3c6e483` (financial continuity) are ancestors, verified with `git merge-base --is-ancestor`.

Primary worktree `/Users/ryanmellors/Projects/Fairshift/app`: branch `fs-square-live-001`, HEAD `822c5fdf53fd330b5f98845141a157dab6e3c9ad`; existing modified `next-env.d.ts` and untracked `.claude/` preserved. Its staging area stayed empty. The integration, Bryntum and financial-continuity worktrees remain clean at their original HEADs.

Read repository instructions, authority register sections 1–2, relevant product/master payment rules, payout service/client, schema, migration integrity trigger and existing regression contracts. This package authorises the work; it does not implement any open tip, holiday-pay or payroll decision.

## B. Worktree created

Created `/Users/ryanmellors/Projects/Fairshift/payout-recovery-worktree`, branch `fs-payout-recovery-guard-001`, directly from the exact integration HEAD. Both proposed path and branch were verified absent first. All source, test and documentation edits are isolated here. Existing local dependencies were temporarily linked for verification; the link was removed afterwards. No dependency installation or lockfile change.

## C. Root cause and original retry behavior

**REPOSITORY EVIDENCE:** after the known-batch GET branch, `refreshWorkPayout()` claimed a no-batch `RECONCILIATION_REQUIRED` payout, or a `SUBMITTING` payout stale by over two minutes, and called `sendReserved(..., "RECONCILE")` without any maximum age. A remotely successful create with a lost local response could therefore be repeated after provider protection expired.

IDs derive deterministically from the payable UUID: remove hyphens, uppercase, prefix `FSWP-B-` / `FSWP-I-`. Recovery reads the original IDs, amount, currency and recipient from the existing reservation. The client also sends the batch ID as `PayPal-Request-Id`. None of this changes.

PayPal currently documents duplicate protection for the same `sender_batch_id` within **30 days**, not indefinitely. Official source checked during this package: [PayPal Payout Sender Batch Header](https://developer.paypal.com/api/payments.payouts-batch/v1/definitions/payout_sender_batch_header/). No authenticated provider API was called.

## D. Timestamp reliability analysis

**REPOSITORY EVIDENCE, with database regression verification:** `reservedAt` / `reserved_at` is explicitly persisted when the initial `SUBMITTING` reservation is inserted, before auditing and before the first provider create can start. `fairshift_work_payout_integrity()` in existing migration `0014_work_payouts.sql` makes it immutable, together with sender IDs and financial facts. All payout writers were inspected: neither `NOT_SENT` submission nor reconciliation resets it.

It is the reliable persisted **earliest bound** for the first create attempt, not a provider receipt timestamp. Sending delays and later `NOT_SENT` retries can make it earlier than the first remotely processed request. Starting the 28-day ceiling there shortens recovery conservatively; it cannot extend protection past the first create attempt.

`submittedAt` is unsuitable: it stays null on an unknown response and can be filled at a later response or duplicate adoption. `updatedAt` moves on retries/status reads. `createdAt` is not used as a fallback. Missing, non-Date, invalid or future `reservedAt` fails closed. No timestamp is invented or backfilled.

## E. Exact implementation changes

Added an internal 28-day no-batch recovery guard before the existing atomic claim and again immediately before create, after the audit await. A rejected first check leaves the payout and audit evidence unchanged. If claim/audit crosses the boundary, the second check issues no create, restores the existing `RECONCILIATION_REQUIRED` state using a conditional update and preserves the original provider error and payout facts. No new state or state-machine transition is introduced.

The existing `UserFacingError` action/feedback mechanism returns `payout-investigation-required`, explaining that the original payout must be investigated with PayPal before further payment action. Manager copy no longer promises indefinite duplicate protection. There is no manual bypass or new payment route.

## F. Recovery behavior before versus after

| Situation | Before | After |
|---|---|---|
| Known provider batch, including old payouts | GET status | Same GET path, before any age check |
| No batch, uncertain/stale, valid age below 28 days | Controlled identical create | Same controlled identical create |
| No batch, age at least 28 days | Could repeat create | No create; investigation feedback |
| No batch, unreliable/future timestamp | No upper-age protection | No create; investigation feedback |
| Recent in-flight submission | Left alone | Unchanged |
| Failed / definitely NOT_SENT payout | Existing submission rules | Unchanged; failed payouts are not automatically resubmitted |

Existing unique payable/sender/provider indexes and atomic compare-and-set claim remain intact. Four simultaneous refreshes were tested while a single recovery request was held in flight: three callers returned without another provider create. The existing two-minute stale-submission recovery still relies on the same sender IDs inside the bounded provider window.

## G. Negative-test matrix and results

All rows below are **VERIFIED locally with mocked providers**, using controlled Date time and disposable in-process PGlite databases. Malformed read values are injected in unit tests because the real schema prevents null timestamp insertion.

| Required case | Result and evidence |
|---|---|
| A: within safe window | PASS: one-hour recovery repeats original request |
| B: 27 days | PASS: recovery preserves original IDs, recipient, approved GBP amount |
| C: exactly 28 days | PASS: zero recovery create requests |
| D: 29 days | PASS: zero recovery create requests |
| E: 30 days and beyond | PASS: 30- and 90-day requests blocked |
| F: missing timestamp | PASS: undefined/null read fails closed, no writes or provider calls |
| G: invalid/future/ambiguous timestamp | PASS: invalid Date, future Date, strings and numeric values refused |
| H: multiple refreshes | PASS: atomic claim permits one in-flight recovery; one reservation retained |
| I: old known batch | PASS: 90-day GET reconciliation still reaches PAID on matching item SUCCESS |
| J: timeout/lost response | PASS: uncertainty remains; duplicate adoption still retrieves original batch |
| K: amount/currency | PASS: exact persisted values reused; database rejects financial edits |
| L: duplicate submission | PASS: one reservation, original batch/item IDs, no extra submission |
| M: non-success/mismatched provider results | PASS: pending/unclaimed/failed/reversed/missing or mismatched amounts do not falsely become PAID |
| N: tenant/role isolation | PASS: cross-tenant, cross-location and worker access denied; auth regression checks preserved |
| O: inactive subscription | PASS: previously earned payable settlement and bounded recovery remain available; operational entitlement remains enforced |
| P: active-subscription flow | PASS: existing approval, payout and status flows retained |

Boundary cases run for both `RECONCILIATION_REQUIRED` and stale `SUBMITTING`. Extra regressions cover one millisecond below cutoff, cutoff crossed during claim/audit, repeated retries that must not reset age, immutable `reservedAt`, delayed `NOT_SENT` retry, and actionable settlement feedback rendered through the existing manager surface.

## H. Typecheck, lint and regression results

**VERIFIED:** final targeted run exited 0: **126 tests passed in 9 files** (33 added tests; 93 existing tests).

| File | Passed |
|---|---:|
| `tests/integration/work-payouts.test.ts` | 39 |
| `tests/unit/work-payout-recovery.test.ts` | 15 |
| `tests/integration/paypal-final.test.ts` | 24 |
| `tests/integration/incentive-payout.test.ts` | 6 |
| `tests/unit/paypal-payout-client.test.ts` | 6 |
| `tests/unit/paypal-client.test.ts` | 7 |
| `tests/integration/auth-request.test.ts` | 11 |
| `tests/integration/auth-tenancy.test.ts` | 7 |
| `tests/integration/subscriptions.test.ts` | 11 |

Commands ran from the isolated worktree using `/Users/ryanmellors/.nvm/versions/node/v24.22.0/bin/node` and the existing local dependencies:

```sh
node node_modules/vitest/vitest.mjs run tests/unit/work-payout-recovery.test.ts tests/integration/work-payouts.test.ts tests/integration/paypal-final.test.ts tests/integration/incentive-payout.test.ts tests/unit/paypal-payout-client.test.ts tests/unit/paypal-client.test.ts tests/integration/auth-request.test.ts tests/integration/auth-tenancy.test.ts tests/integration/subscriptions.test.ts --reporter=verbose
node node_modules/typescript/bin/tsc --noEmit --incremental false
node node_modules/eslint/bin/eslint.js src/server/payments/work-payouts.ts src/app/components/workspace-ui.tsx src/app/manager/workspace.tsx tests/integration/work-payouts.test.ts tests/unit/work-payout-recovery.test.ts
git diff --check
```

TypeScript, affected-file ESLint and `git diff --check`: **PASS**, exit 0. Test database setup applied the existing migration files only to fresh, disposable in-memory PGlite instances. No migration was created or applied to an application/hosted database.

The initial integration run exposed a test setup ordering mistake (changing worker payment settings after cancellation), corrected by performing that setup while entitled. An initial unit-test mock signature was corrected after typecheck. Final verification below supersedes those failed development checks. Existing Bryntum trial CSS source-map files are absent from the installed dependency and Vite emitted warnings; no dependency files were changed.

No full suite or build was required: the targeted checks found no broader implementation impact. No browser, hosted or genuine Sandbox verification is claimed.

## I. Financial invariants preserved

No schema/migration change, first-attempt reset, new sender identifiers, replacement payable, amount/currency edit, recovery recipient change, alternative provider route, approval bypass, permission bypass, evidence deletion or manual payment override. Unknown results do not become FAILED without provider evidence. PAID still requires provider item SUCCESS and the approved amount/currency. Known batch/item/transaction identifiers are never fabricated.

## J. Remaining provider or runtime limitations

**NOT VERIFIED:** genuine PayPal/Square operations, hosted runtime behavior, browser acceptance and the complete integrated live Golden Path. No provider calls, transactions, hosted database writes or deployments were authorised or performed. Mocked Square-attributed earnings-to-payout regression coverage passed; it is not new external verification.

Expired or unreliable no-batch payouts require investigation of the original request; this package deliberately adds no manual settlement or identifier-adoption tool. Clock evaluation uses server UTC epoch milliseconds and an earlier immutable reservation bound, with a two-day margin inside the documented provider window. No claim is made that every payout inside the window must be retried.

## K. Exact changed-file inventory

- `src/server/payments/work-payouts.ts`: guard and immediate pre-create recheck using existing states.
- `src/app/components/workspace-ui.tsx`: investigation feedback text.
- `src/app/manager/workspace.tsx`: bounded-recovery explanation only.
- `tests/integration/work-payouts.test.ts`: 18 added integration cases and strengthened sender-item/time immutability assertions.
- `tests/unit/work-payout-recovery.test.ts`: 15 new malformed-time / cutoff-crossing cases.
- `docs/FS-DOCUMENT-AUTHORITY-REGISTER.md`: package start/close pointer and evidence classification.
- `docs/PAYOUT_RECOVERY_GUARD_EVIDENCE.md`: this report.

## L. Final branch, HEAD and Git status

Branch `fs-payout-recovery-guard-001`; full HEAD remains `36178784ba600c0b25132c8952a2bfa8fc638f72`. Five tracked files modified and two new files untracked, as listed above. Staging area empty. No commits, push, merge, history rewriting or deployment. Other worktrees retain their preflight HEADs and Git states. Temporary verification logs remain outside the repository at `/private/tmp/fs-payout-recovery-verification.log`.

## M. Verdict

**PASS — local implementation and deterministic regression verification.** The original immutable reservation time supplies a conservative first-attempt bound; unsafe or unknowable no-batch recovery is blocked, known-batch GET reconciliation is preserved, and no schema change or financial bypass was introduced. The existing integration Golden Path contracts pass in mocked regression tests; complete hosted/provider Golden Path acceptance remains **NOT VERIFIED**. Work is complete within this package and stopped; no successor is authorised.
