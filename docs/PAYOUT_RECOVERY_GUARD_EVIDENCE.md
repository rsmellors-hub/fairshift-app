Working note from the build. It may describe an earlier state. The README and docs/SUBMISSION_EVIDENCE.md describe the submitted build.

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


## Integration verification — FS-HACK-PAYOUT-RECOVERY-INTEGRATE-001

5 November 2026. Owner-authorised local integration only, advancing the existing allocation-to-settlement path and roadmap steps 13–15. The original sections above describe the source package's pre-commit checkpoint; they are historical status, not the final state of the integration worktree.

### Baseline and merge review

Verified clean destination `fs-hack-integrate-001` at `36178784ba600c0b25132c8952a2bfa8fc638f72` and clean source `fs-payout-recovery-guard-001` at `159fde58dd0f8506c7a17992b6fbb43d275f8693`, a direct child of the destination HEAD. Source subject and the exact seven-file contribution matched the Owner's package. No in-progress merge or other Git operation was present. The primary worktree's modified `next-env.d.ts` and untracked `.claude/launch.json` were recorded with content hashes for preservation; the other protected worktrees were clean at their supplied commits.

Executed `git merge --no-ff --no-commit 159fde58dd0f8506c7a17992b6fbb43d275f8693` in the integration worktree. No conflict occurred. Reviewed the complete staged contribution. Application and test files remain byte-for-byte identical to the recovery source commit. Only this evidence addendum and the required authority-register status pointer add integration-specific documentation; the merged file inventory remains exactly the seven files in section K.

### Financial and UI controls

**VERIFIED locally by code review and mocked regression tests:** the Owner's financial invariants A–M remain intact. Approved amount/currency come from the database; existing role, tenant and location controls remain; inactive subscriptions retain settlement access while operations remain gated; each payable retains its unique reservation; recovery reuses immutable original sender identifiers and financial facts. No-batch uncertain recovery fails closed at 28 days and for unreliable timestamps, including a second pre-create check after claim/audit. Old known batches still reconcile by GET. Non-success, unknown, reversed and mismatched outcomes are not called PAID; matching authoritative item SUCCESS is required. No replacement payable, identifier reset or new payout route was added.

Manager SSR and action regressions preserve scheduling, drag-to-offer, mandatory worker acceptance, manager-finalised allocation, forecast-gap updates, normal Review & pay navigation and restricted inactive-subscription settlement. Restricted settlement does not expose scheduling. An uncertain payout has no ordinary Send action; its Check payment status action reaches the server-side guard and returns investigation feedback when recovery is unsafe. No success is claimed for an unconfirmed payout. Public-demo write controls remain in place. No new browser acceptance was run; the Owner's prior Chrome acceptance was on destination base `3617878`.

### Executed validation

- Targeted combined regressions: **207/207 tests passed, 15/15 files**, zero failed or skipped. Includes work payouts 39, recovery unit tests 15, PayPal final 24, incentive payout 6, payable creation 13, auth request 11, tenancy 7, subscriptions 11, demo controls 24, schedule authority 21, schedule Golden Path 10, allocation scheduler 2, allocation model 11, PayPal payout client 6 and PayPal client 7.
- Full suite: **974/974 tests passed in 73/73 files**, zero failed, skipped or hung; exit 0. Runtime **1,975.22 seconds** (97% tests, 3% imports); 73 isolated workers. The Owner-requested stall diagnosis found fresh log output and advancing completed cases (483 → 526 → 558 and onward), with CPU-bound PGlite work. The repository intentionally disables file parallelism and starts/migrates a fresh WASM PostgreSQL instance per integration test. No hanging test was found, and no runner, worker or unrelated process was terminated. The final JSON was emitted normally at completion.
- TypeScript: `node node_modules/typescript/bin/tsc --noEmit --incremental false`, **PASS**, exit 0.
- Repository-wide ESLint: `node node_modules/eslint/bin/eslint.js .`, **PASS**, exit 0.
- Complete production build: `node node_modules/next/dist/bin/next build --webpack`, **PASS**, exit 0, including compilation, TypeScript, page-data collection, static generation, optimisation and build traces. The first credential-free attempt failed because checkout prerendering constructs a database client before reading cookies and required DATABASE_URL. The successful retry used the existing isolated loopback test-database URL with no provider credentials, no running database server and an external-fetch blocker. No external fetch was attempted. No shared environment file was read, copied or modified.
- Final staged whitespace check: **PASS**, exit 0.

All commands used the manifest's Node v24.22.0 and verified existing dependency versions. Manifest and lockfile exactly matched the dependency target; no dependency was installed or changed. The package's single temporary node_modules symlink was removed after validation. Tests used fresh in-process PGlite instances and existing migrations only within that disposable harness; no application or hosted database migration was run. Full-suite execution disabled test-result caching and inherited the external-fetch blocker. Existing context-signal tests attempted two Open-Meteo refreshes; the blocker stopped both before transmission, and the failure-path tests passed. No request reached the provider. The Owner-requested controlled-recovery TypeScript and affected-file lint rechecks also passed, exit 0. The sole unstaged register edit during testing was this package's required active-work pointer, not a concurrent edit; its provenance and staged source version were inspected before final staging. Verification logs and JSON results are retained at `/private/tmp/fs-payout-integrate-*` outside Git.

### Commit, boundaries and remaining gates

One local non-fast-forward merge commit uses the Owner-authorised message `merge: integrate PayPal payout recovery guard`; its resulting hash is supplied in the completion report rather than self-referenced here. Its parents are `36178784ba600c0b25132c8952a2bfa8fc638f72` and `159fde58dd0f8506c7a17992b6fbb43d275f8693`; both original histories are preserved. Recovery, Bryntum `e4279a7787c7ebe9078f202098c356367d0dcfc8` and financial continuity `bdc8e8e0ee43b8c1555908587109fbb5a3c6e483` remain ancestors.

No PayPal, Square or AI provider call, genuine transaction, push, deployment, schema/dependency change, marketing change or successor package was performed or authorised. Genuine Sandbox verification of the integrated guard, hosted release verification and a complete hosted Golden Path remain separate Owner-authorised gates. Expired/untrustworthy no-batch payouts still require investigation of the original request; no manual bypass or settlement tool was introduced. This local mocked integration does not promote provider or demo-readiness status.
