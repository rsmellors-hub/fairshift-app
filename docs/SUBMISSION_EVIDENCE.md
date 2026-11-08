# FS-HACK-SA-SUBMISSION-001 — Submission evidence

The single evidence file for FS-HACK-SA-SUBMISSION-001. Status terms follow `AGENTS.md` §8. Each
entry says what was run, where, and what was observed; nothing here is a hosted or demo-ready claim.

## Day 4, Checkpoint A — runtime, DEC-SA-012, casual Pay Agent (7 November 2026)

**Environment.** Branch `submission`, local only. A scratch PostgreSQL 15 cluster (127.0.0.1, port
55432, database `fairshift_runtime`) migrated to `0028`. `next dev --webpack` on port 3105 with
`FAIRSHIFT_DEPLOYMENT_MODE=HOSTED_SANDBOX_DEMO`, the Jacaranda Table Demo organisation
(`846ff1bc-fe0a-45fb-b0f0-3ab44ba1f1e4`) as the Sandbox organisation and
`FAIRSHIFT_PAY_AGENT_DRY_RUN=true`. Local people and accounts were made by
`scripts/seed-sa-runtime.ts` (synthetic `*.example.test` identities through the normal invitation,
policy, offer, acceptance and allocation operations). Its subscription row is a labelled
`LOCAL-RUNTIME-FIXTURE`, not a PayPal subscription. No PayPal request was made in Checkpoint A.

### A1 — real server

| Check | Result |
|---|---|
| Server start | **Defect found and fixed.** `src/instrumentation.ts` was bundled for the Edge runtime too; its early-return guard did not stop webpack following the import into `pg`, so `next dev` failed with `Can't resolve 'fs'`. Moved the import inside `if (process.env.NEXT_RUNTIME === "nodejs")` (Next.js's documented pattern). After the fix the server starts and `/api/health` returns 200. VERIFIED |
| Role routes (headless Chrome over CDP, real sign-in form) | Owner `/owner`, `/owner/payments`, `/owner/locations`; Manager `/manager`, `/manager/review`; Worker `/worker` (390×844) all load signed in, show Jacaranda Table Demo / Rosebank, with no browser console errors. VERIFIED |
| Background processing | Manager confirmed "Runtime clean floor" in the browser; the action answered in 3.5 s and redirected. Event `136fe7a3…` was recorded at 11:22:31.070 and claimed by `after()` at 11:22:34; one genuine OpenAI call, response `resp_029ff069456be4c6016aeeeddc9aa087d280dbf903c49c5f41`, decision **SETTLE**; settlement gates then ended at `SETTLEMENT_BLOCKED / payment-details-required` with `dry_run = true` (no Sandbox recipient saved). VERIFIED |
| Genuine discrepancy | "Runtime late confirmation" (work ended nine days earlier) confirmed in the browser: **HOLD / CONFIRMATION_DELAY**, summary "Manager confirmation was recorded 13,178 minutes after the scheduled shift end.", response `resp_0a6422bef32c4f28016aeeedf6af3c87d2ac6aa03dff2d0e87`. VERIFIED |
| Stop mid-processing, restart, sweep | "Runtime recovery floor" confirmed in the browser; the server (only this job's port-3105 process) was SIGKILLed when its event appeared. The dying `after()` had claimed it: `CLAIMED`, attempt 1, 0 model calls, lease to 11:26:00. Restarted after the lease: the startup sweep (no request) took the event over and finished it at 11:26:19 — attempt 2, **exactly one** model call (`resp_0161d51be9489a54016aeeeeb9e24887d2bcadbbe8af1a8ef5`), HOLD / CONFIRMATION_DELAY (27.6 h after the shift end). Audit shows one `PAY_AGENT_EVENT_RECORDED` and one `PAY_AGENT_ATTEMPT_FINISHED`. VERIFIED |

### A2 — DEC-SA-012 ECB reference rate

- Table `fx_reference_rates` (`drizzle/0028_fx_reference_rates.sql`): one immutable row per ECB
  reference date, the two published quotes, the derived ZAR-per-USD micro-rate (EUR/ZAR ÷ EUR/USD,
  rounded up at six decimals so the converted USD never exceeds the exact cross rate, enforced by a
  check constraint), source `ECB_EUROFXREF_DAILY` or `OWNER_MANUAL` (recorder required).
- Reservation reads the newest rate (`src/server/fx/reference-rates.ts`, `currentZarConversion`)
  and freezes rate and `fx_rate_source` (`ECB_EUROFXREF_DAILY:<date>`) on `work_payouts` (Day 2B
  columns and immutability trigger); a resend reuses the frozen values.
- Freshness: a rate dated on or after the third Monday–Friday day before today (UTC calendar) is
  usable; otherwise `provider-fx-rate-unavailable`. ECB/TARGET holidays are not modelled, so a long
  holiday can block payouts until a newer rate is recorded: fail closed.
- **Real ECB fetch, VERIFIED:** `scripts/fx-ecb.ts` read
  `https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml` on 7 Nov 2026: reference date
  **2026-11-06**, EUR/ZAR **18.4649**, EUR/USD **1.1165**, derived **16.538200 ZAR per USD**
  (`16538200` micros). Stored in the local runtime database only.
- Manual fallback: Owner of the configured Sandbox organisation only, on `/owner/payments`
  ("Payout exchange rate"), audited; recorded rates can't be replaced.
- Stretch (automatic daily fetch): NOT IMPLEMENTED.

### A3 — casual Pay Agent adjustments

- FS-APPROVER-DEC-001: the automatic approval audit carries `approverOfRecord` (the confirming or
  hold-releasing manager), `approverDecision: FS-APPROVER-DEC-001` and the basis text
  (`src/server/payments/work-payouts.ts`, `CASUAL_APPROVER_BASIS`). Tested.
- Model instruction: confirmation within 24 hours of the shift end is normal practice and not by
  itself a reason to hold (context, not a server threshold). Tested.
- Seeded SETTLE and HOLD cases: see A1 above.

### Checkpoint A verification

- Baseline at `a0121dc` (before any edit): typecheck and lint PASS; 83 files / 1,064 tests: 1,058
  passed, 5 skipped (real-PostgreSQL file, no URL set), 1 failed by a 30 s timeout
  (`performance-incentive`), which passed 16/16 when run alone. The 5 real-PostgreSQL tests then
  passed against the scratch cluster.
- Retired-test audit: the Day 3 rewrite of `tests/unit/pay-agent.test.ts` replaced 22 `it`/`it.each`
  blocks (109 cases) of the superseded execution-disabled foundation. Each category maps to current
  coverage: strict contract (`tests/unit/pay-agent.test.ts`), service identity and forged triggers
  (`pay-agent-processing` "refuses another tenant's credential…", "does not disclose…"), evidence
  gaps (`pay-agent-events` "orders deterministic pre-model outcomes…"), financial idempotency and
  concurrency (`pay-agent-events`, `pay-agent-postgres`), model failure classes
  (`pay-agent-processing`), evidence changing mid-decision, approval authority (`pay-agent-workflow`
  "refuses the worker's own release"), provider status mapping (presentation). No critical gap
  found; no superseded test restored.
- After the last Checkpoint A edit: typecheck PASS, lint PASS; full suite with the real-PostgreSQL
  URL set: **84 files, 1,076 tests: 1,074 passed, 2 failed, 0 skipped** (1,739.86 s). Both failures
  were 30 s timeouts in `tests/integration/ai-staffing.test.ts` (lines 171 and 216), not assertion
  failures. Re-run alone with the other files that had been slow in an earlier, overloaded run:
  `ai-staffing`, `pay-agent-events`, `reference-refresh`, `owner-onboarding` — **4 files, 49/49
  passed** (98.16 s). Committed on the Owner's instruction ("If the slow ones pass alone, commit A").
- `owner-onboarding` migration count updated 28 → 29 for `0028`.

## Day 4, Checkpoint B — first Sandbox payout for confirmed casual work (7 November 2026)

**Preconditions, all checked at runtime before any PayPal request:** payout config resolves to
`https://api-m.sandbox.paypal.com` and equals the code constant (`src/server/config/env.ts`; the
`src/server/integrations/paypal/payout-client.ts` constructor refuses any other host, tested in
`tests/unit/paypal-payout-client.test.ts`); Sandbox credentials present (presence only); a Sandbox
personal-account recipient supplied by the Owner in a local file, saved through the worker's own
payment settings and never printed; fresh DEC-SA-012 rate (ECB 2026-11-06); the Sandbox
organisation is the Jacaranda Table Demo only. The startup sweep had nothing it could settle
(0 payouts before).

| Step | Observed (local server, scratch database) |
|---|---|
| Dry run off, local only | `FAIRSHIFT_PAY_AGENT_DRY_RUN=false` from a local override file for one server run |
| Normal flow | Manager confirmed "Runtime sandbox payout" (3 h × R45.00 = R135.00) in the browser; `after()` → genuine OpenAI decision **SETTLE** (`resp_03ef5a76731e4d05016aef0059cdac87d286fef2acfa501c5b`) → settlement gates → `SETTLEMENT_SUBMITTED / PAYOUT_RESERVED` |
| Frozen provider leg | R135.00 → **US$8.16** at **16.538200 ZAR/USD**, `fx_rate_source = ECB_EUROFXREF_DAILY:2026-11-06`, rounded down |
| Approver of record | The confirming manager; audit basis "Manager confirmation at preauthorised fixed terms (DEC-SA-011)", `FS-APPROVER-DEC-001` |
| PayPal create | Sender batch `FSWP-B-248DB329D0F143029284E5FA2769DC68`; PayPal batch **`CDYVQTZNSZKYU`**, batch `PENDING`, no item yet → FairShift `PROCESSING` (not paid) |
| Status refresh (manager "Check payment status") | PayPal item **`FWA2DGAD9QH42`** `SUCCESS`, batch `SUCCESS`, transaction `65982028V6398071A`; amount and currency matched the frozen leg → FairShift **`PAID`** at 12:42:11 SAST |
| Worker view (390 px) | "Paid"; "$8.16 for ZAR 135.00, at 16.5382 ZAR per USD, the European Central Bank reference rate of 2026-11-06"; no recipient or PayPal ID shown; no console errors |
| Dry run restored | Server restarted without the override; manager retried the earlier blocked "Runtime clean floor" payable → `DRY_RUN_ELIGIBLE`, `dry_run = true`; still **exactly one** payout in the database |

Exactly one PayPal payout was created; no retry or resend. The recipient is a PayPal Sandbox
personal test account, not a South African recipient: SA recipient eligibility remains NOT VERIFIED.
Checkpoint B changed no application or test code (local seed script and this file only); the
Checkpoint A suite result applies to the unchanged application code.

## Day 4, Checkpoint C — AI-verified shift-pool tip release (7 November 2026)

Implements FS-TIP-DEC-002, FS-TIP-AGENT-DEC-001 and the Owner's append-only hold-record
requirement (recorded verbatim in `docs/FS-HACK-SA-AMENDMENT-001.md`). Migration `0029_tip_release`.

**Design, reused infrastructure.** Permanent staff are `workers` rows with `worker_type = REGULAR`
(no login, never offered work: the casual pool, offer eligibility and the Bryntum team now filter
`CASUAL`). Tip lines are paid through the existing payout engine: `work_payouts` gains a
`tip_line_id` obligation (exactly one of payable or tip line, one payout per line), reusing
`prepareWorkPayout` (frozen ECB leg, verified route, saved recipient), the reservation, sender IDs
(`FSTP-…`), send and provider-outcome handling. The Pay Agent's existing model transport, service
credential, dry-run flag, claim/lease/fencing rules and startup sweep are reused for a tip journal
(`tip_agent_events`). Evidence rows, allocations, lines, holds, hold decisions and destination
events are database-enforced immutable or append-only.

**Demo locations.** Sandton (SA02) = SHIFT_POOL, blocks Morning 07:00–12:00, Afternoon
12:00–17:00, Evening 17:00–23:00 (Africa/Johannesburg); Rosebank (SA01), Pretoria Central,
Durban North, Cape Town Gardens = DIRECT. Auto-release cap R1,500 per staff member per day.
`scripts/seed-sa-tips.ts` seeds five synthetic permanent staff (front and back of house), a Friday
block roster and one casual confirmed shift (Sandton, 6 Nov 2026 11:00–15:00, inside Morning and
Afternoon), and fills the synthetic CSV templates in `scripts/demo/` with each person's own
(immutable) POS reference. All tip rows are synthetic demo data labelled `IMPORTED_POS_EVIDENCE`.

**Runtime journey (headless Chrome over CDP, local server, dry run on):**

| Step | Observed |
|---|---|
| Owner settings | Policy, cap, blocks and a roster saved through `/owner/tips` forms |
| Sandton import | 12 rows, R778.51, policy shift pool; one row at 23:20 local is `OUTSIDE_BLOCKS`, unallocated and visible |
| Allocation | Morning R100.50 → R33.50 × 3 (Busi, Kagiso, casual Naledi); Afternoon R90.01 → R30.01 / R30.00 / R30.00 (remainder to the lowest staff ID); Evening R580.00 → R290.00 × 2 |
| Pay Agent (genuine OpenAI) | Morning **RELEASE** `resp_0b9d999982fea54e016aef029740b087d2917f3914e71947c0`; Afternoon **RELEASE** `resp_0319c13271717f44016aef029436f487d291658191ec1eefe6`; Evening **HOLD / TIP_OUTLIER** "One pooled tip row exceeds its bill." `resp_000a5d40a7746130016aef0290715887d298ca0474510a6ee4` (the R480 tip on a R120 bill) |
| Gates before confirmation | Permanent staff `staff-destination-unconfirmed`; casual `payment-details-required` (no PayPal email saved) |
| Owner hold decisions | "Kept held" then "Released as calculated", each by the Owner with a written reason and time; both shown permanently |
| Staff statement (dev-only link) | Own shares only, policy in plain words, status "recorded", destination confirmed once; a second destination action through the same link is refused; token stripped from the address bar; 0 network requests carried it |
| Token in logs | **Defect found and fixed:** Next.js development logged Server Function arguments, so the first link's token reached the local server log. `next.config.ts` now sets `logging: { serverFunctions: false }` (tested); that scratch link was revoked; after the fix the token appears 0 times in the log |
| After confirmations, Owner reruns the checks | Every permanent-staff line `DRY_RUN_ELIGIBLE`, including Evening on the Owner's release; casual lines still blocked; **0 tip payouts** (dry run) |
| Casual view (390 px) | "Your tips": Morning R33.50 and Afternoon R30.00 pooled shares, "Recorded" |
| Rosebank (DIRECT) import | R151.80 to two permanent staff (R112.20, R39.60); the casual's R23.00 row recorded as `CASUAL_SHIFT_PAY`; **RELEASE** `resp_06c79ad84c55a2ea016aef077805e087d2b249d6654f286a8f`; lines blocked until the staff confirm destinations |
| Manager | `/owner/tips` redirects a manager to `/account`; no tip actions |

**Not done in this checkpoint.** No live tip payout was made (dry run; the Sandbox payout of
Checkpoint B is the only PayPal request). A DIRECT casual's tips are recorded for shift pay, but the
casual payable has no tip line yet, so FairShift does not pay them (stated on screen). Statement
link email delivery is not connected; the development-only opener is refused in production builds.

**Checkpoint C verification (after the last edit).** Typecheck PASS; lint PASS with 0 warnings;
full suite with the real-PostgreSQL URL set: **88 files, 1,103 tests, all passed, 0 skipped**
(1,148.57 s). The first full run failed 2 of 1,103 tests, both asserting the old "FairShift doesn't
allocate tips" copy that FS-TIP-DEC-002's supersession required to change; those assertions now check
the new copy (`square-live`, `wage-intelligence`), with every money assertion unchanged. New tests:
`tests/unit/tip-policy.test.ts` (10), `tests/integration/tips.test.ts` (14),
`tests/integration/tips-postgres.test.ts` (2, real PostgreSQL: concurrent releases fit under the cap
once; six concurrent releases of one line reserve one payout and call PayPal once),
`tests/unit/server-function-logging.test.ts` (1).

## Day 4, Checkpoint D — browser golden path (7 November 2026)

Headless Chrome over the DevTools protocol against the local server (scratch database, dry run on
except where stated); real sign-in forms and server actions, no API shortcuts.

**Casual journey (real accounts), VERIFIED:** the Rosebank manager created a 15-minute shift
(14:15–14:30 SAST) on the preauthorised R45.00/hour terms and offered it from the worker pool; the
casual (390 px, no overflow) acknowledged the disclosed terms and accepted; the manager finalised
the allocation and, after the shift ended, confirmed it. `after()` ran the Pay Agent: genuine OpenAI
**SETTLE** (`resp_0055faee0ead7fe1016aef1c34de8487d2a58a37143c09da46`) → `DRY_RUN_ELIGIBLE`; the
worker sees "Pay pending" for R11.25. The database still holds exactly one payout (Checkpoint B's,
PAID). The Sandbox payout path itself is the Checkpoint B run.

**Forecast:** synthetic reference history is shown only to public demo personas
(`syntheticHistoryAllowed`, `src/server/intelligence/sales-history.ts:36`), and demo personas can
never trigger the Pay Agent (Day 3 rule). So no single session covers forecast → Pay Agent: a real
account sees "No location has eligible sales history yet". With local demo personas enabled, the
demo Owner saw next week's forecast (5,731 expected transactions, ZAR 598,429, "Reference sales
history · synthetic") and the demo Manager at Rosebank saw "Tuesday needs the most cover · 24 h
regular staff + 4.5 h gap to fill". **OPEN:** an authenticated rehearsal context that can see the
labelled reference forecast and still run the Pay Agent needs an Owner decision (roadmap §6).

**Tips journey:** exercised in the browser during Checkpoint C (above).

No false PAID was shown anywhere; the only PayPal request was Checkpoint B's.

## Checkpoint E — PayPal Sandbox negative testing (7 November 2026)

Owner requirement (Ryan, 7 Nov 2026). PayPal Sandbox only (`api-m.sandbox.paypal.com`, asserted per
request); receiver `payouts-simulator-receiver@paypal.com`; PayPal's documented test values
(Payouts: `items[0].note` on create or the path ID on GET; Subscriptions: `plan_id` or the path ID).
Negative Testing is active on the Sandbox business account (the second run below returned the
simulated errors). No credential or token was printed or stored.

**Postman / Newman.** `docs/paypal-negative-tests/fairshift-payouts.postman_collection.json`
(generated by `build-collection.mjs`), environment template
`fairshift-sandbox.postman_environment.template.json`; local environment outside the repo (mode
600). Newman 6.2.1, one call per code. **The first run is void:** the collection stored the token in
a collection variable that the environment's empty `access_token` shadowed, so all 24 calls were
refused `401 AUTHENTICATION_FAILURE` before any processing (nothing created). After the fix, one
second run per code; summary without tokens: `docs/paypal-negative-tests/newman-summary-2026-11-07.json`.

**FairShift real flow.** `scripts/paypal-negative-run.ts`: for each create code, a manager confirmed
one hour of work on preauthorised R45.00/hour terms, the Pay Agent decided (genuine OpenAI), the
settlement gates ran and the shared engine called PayPal Sandbox once with the code as the note
(sandbox-only switch `FAIRSHIFT_PAYPAL_NEGATIVE_TESTS`, refused in production builds, tested). The
model held `ERRPYO001` and `ERRPYO003` (`CONFIRMATION_DELAY`; one summary wrongly called 850 minutes
"exceeding the normal 24-hour window" — a model error that failed safe), so the Rosebank manager
released those holds through the normal path and settlement ran once each.

| Code | PayPal (Newman) | FairShift real flow → payout · journal · payable · worker | Required outcome |
|---|---|---|---|
| ERRPYO005 | 422 `INSUFFICIENT_FUNDS` | `FAILED` (REJECTED) · SETTLEMENT_SUBMITTED · APPROVED · "Pay pending"; plain reason shown | Terminal, plain reason — met |
| ERRPYO006 | 500 `INTERNAL_ERROR` | `RECONCILIATION_REQUIRED` (UNKNOWN); recovery resent the identical request, **same `sender_batch_id`**, 1 payout row, attempts 2 → PayPal batch `9DCT2FMNAW2T2`, item PENDING → `PROCESSING` | Reconcile, same ID, never a second payout — met |
| ERRPYO035 | 429 `RATE_LIMIT_VALIDATION` | `NOT_SENT`; immediate resend refused `payout-retry-later` (60 s backoff, same IDs after) | Retryable with backoff — met |
| ERRPYO036 | 504, no error name (non-JSON) | `RECONCILIATION_REQUIRED` (`MALFORMED_RESPONSE`, UNKNOWN); plain reason added | Reconcile — met |
| ERRPYO038 | 400 `NON_HOLDING_CURRENCY` | `FAILED` (REJECTED); plain reason | Terminal — met |
| ERRPYO039 | **400** `PREVIOUS_REQUEST_IN_PROGRESS` | `RECONCILIATION_REQUIRED` (UNKNOWN). **Fixed:** status-only mapping would have made this 400 `FAILED` | Retryable/in progress — met after fix |
| ERRPYO001 | 403 `SENDER_RESTRICTED` | `NOT_SENT` (refused before processing); owner-actionable plain reason | Owner-actionable — met |
| ERRPYO003 | 403 `AUTHORIZATION_ERROR` | `NOT_SENT`; owner-actionable plain reason | Owner-actionable — met |
| ERRPYO018 | GET batch (no query): 200 `SUCCESS` | FairShift's status read (`?fields=items`): 404 `INVALID_RESOURCE_ID` → refresh refused, recorded status unchanged; a SUCCESS batch whose item isn't ours stays `PROCESSING` (fake test) | No false PAID; duplicate never paid twice — met |
| ERRPYO043 | item `DENIED` | **Fixed:** item `DENIED` now `FAILED` (was left `PROCESSING`), reason shown (fake test; FairShift reconciles by batch GET, not the item endpoint) | Terminal — met after fix |
| ERRPYO045 | item `FAILED` | `FAILED`, reason (fake test) | Terminal — met |
| ERRPYO047 | item `UNCLAIMED` | `PROCESSING` + "waiting for the worker to claim", reason (fake test) | Owner-actionable, not paid — met |
| ERRPYO049 | item `DENIED` | `FAILED` after the fix, reason (fake test) | Terminal — met after fix |
| ERRPYO052 | item `FAILED` | `FAILED`, reason (fake test) | Terminal — met |

No case produced `PAID` or a second payout. Worker-facing status for these is "Pay pending" (with
PayPal's "nothing has been paid" note), never "Paid". Fakes for every code:
`tests/integration/paypal-negative-codes.test.ts` (25 tests, including both 4xx variants where the
docs give no status, and the statuses the Sandbox actually returned).

**Subscriptions.**

| Code | PayPal (Newman) | FairShift behaviour (fake provider, real service) |
|---|---|---|
| ERRSUB032 create | 500 `INTERNAL_SERVER_ERROR` | No subscription or access; single PENDING row (no orphan); retry reuses the request ID; owner sees "That checkout isn't available right now… Your account is saved." |
| ERRSUB033 create | 401 `NOT_AUTHORIZED` / `PERMISSION_DENIED` | Same |
| ERRSUB034 create | 400 `INVALID_REQUEST` / `INVALID_PARAMETER_SYNTAX` | Same |
| ERRSUB039 create | 422 `UNPROCESSABLE_ENTITY` / `PLAN_STATUS_INVALID` | Same |
| ERRSUB044 show | 500 `INTERNAL_SERVER_ERROR` | Refresh refused; status and verification not guessed; no access |
| ERRSUB046 show | 404 `RESOURCE_NOT_FOUND` | Same |
| ERRSUB066 / 069 activate | 500 / 422 `SUBSCRIPTION_CANNOT_BE_ACTIVATED` | Postman only: FairShift never calls activate |
| ERRSUB063 / 065 cancel | 500 / 404 `RESOURCE_NOT_FOUND` | Postman only: FairShift never calls cancel |

Also tested (`tests/integration/subscription-negative.test.ts`, 12 tests): abandoned or cancelled
approval stays pending with no access and restarts with the same subscription; repeated sign-up
creates one subscription; invalid webhook signature rejected (401) with no change; a replayed event
is processed once; out-of-order events can't regress status (FairShift reads PayPal's current state
on every event); **fixed:** `BILLING.SUBSCRIPTION.PAYMENT.FAILED` was rejected as `INVALID_EVENT`
(the event-type pattern allowed one segment only) and is now reconciled. Existing subscriptions on
original plans: covered by the existing `subscriptions.test.ts`.

**Positive sign-up: BLOCKED.** Approving a Sandbox subscription needs the Sandbox buyer account's
login, which isn't available here (only its email). No subscription was created, so none is left
orphaned. FS-SUBSCRIPTION-TRIAL-001 (status during the trial) remains UNVERIFIED. Configured plans,
read through FairShift's adapter: all `ACTIVE`, **GBP**, each with a 30-day free trial — Single
outlet £29.00/month or £290.00/year; Multi outlet £69.00/month or £690.00/year. Pricing unchanged.

**Checkpoint E verification (after the last edit).** Typecheck PASS; lint PASS, 0 warnings; full
suite with the real-PostgreSQL URL: **90 files, 1,140 tests, all passed, 0 skipped** (1,350.98 s).

## Fix — server-computed confirmation window for the Pay Agent (7 November 2026)

In Checkpoint E the model held work confirmed 850 minutes after the shift end, calling it "exceeding
the normal 24-hour confirmation window" (850 minutes is 14.2 hours). The model view now carries
server-computed `managerConfirmation.hoursAfterScheduledEnd` (one decimal) and
`withinNormalConfirmationWindow` (true at ≤ 24 hours) next to `minutesAfterScheduledEnd`
(`src/server/pay-agent/evidence.ts`, `confirmationTiming`), and the instruction tells the model to
rely on them. The model still decides SETTLE or HOLD; the server facts are context, not a rule.

One genuine OpenAI call each (local scratch database, dry run on, no PayPal request):

| Confirmation | Server facts | Decision | Response |
|---|---|---|---|
| 14 h after the end | 840 min · 14.0 h · within window | **SETTLE** | `resp_0e8a4d84404d3213016aef8d8e1ac087d286baac6c07e97e93` |
| 27.7 h after the end | 1,662 min · 27.7 h · outside window | **HOLD / CONFIRMATION_DELAY** ("…27.7 hours after the scheduled shift end, outside the normal confirmation window.") | `resp_08ff44b210c006f5016aef8d91aa9487d2b9441e5d4db96e49` |
| 2 h after the end (clean) | 120 min · 2.0 h · within window | **SETTLE** | `resp_064a26f0c1c9edd6016aef8d952f3c87d299185f52f8c6dc14` |

Both SETTLEs then stopped at the settlement gate `payment-details-required` (the synthetic test
worker has no PayPal email), as designed. Unit test covers 850 min → 14.2 h within, 1,662 min →
27.7 h outside, and the 24-hour boundary (1,440 within, 1,441 outside).

Verification: typecheck PASS; lint PASS, 0 warnings; full suite with the real-PostgreSQL URL **90 files,
1,141 tests, all passed, 0 skipped** (1,676.04 s).

## Day 5, Checkpoint 1 — Owner decisions of 8 November, AI discovery cadence (8 November 2026)

**Decisions (step 1).** The four Owner decisions confirmed by Ryan on 8 November 2026 (staffing gate,
roles, bands, AI discovery cadence) are recorded verbatim, dated, in `docs/FS-HACK-SA-AMENDMENT-001.md`
section 5. The 7 November decisions DEC-SA-012, FS-TIP-DEC-002, FS-TIP-AGENT-DEC-001 and
FS-APPROVER-DEC-001 were already recorded verbatim there: VERIFIED by reading. Gap, not filled: code
committed earlier on 8 November cites further "Owner decision(s), 8 November 2026" (local intelligence,
disruptions, early shift notice, track record, Owner-entered event links) whose text is in no document.

Read-only check of the code against the three decisions it did not need to change: UNCONFIRMED signals
are never applied (`blockAdjustments` takes ACCEPTED only); bands are 500 or 1,000 basis points
(`LOCAL_BAND_BPS`); at most two signals shape a block (`MAX_APPLIED_PER_BLOCK`) and blocks are clock
hours, so at most two per hour; FOH/BOH is shown and used nowhere else. One difference: staffing changes
only on an explicit acceptance, but the server accepts it from an Owner as well as a Manager
(`decideLocalAdjustments`). Reported, not changed.

**Cadence (step 2).** `src/server/scheduler/feeds.ts`: `intel:daily` at 05:00 and `intel:disruptions` at
17:00, Africa/Johannesburg, one call per demo location per slot. 05:00 searches every category; 17:00 is
the short-notice check (the two existing run kinds, now on fixed times: an implementation choice, not in
the decision). Each pass is persisted in `scheduled_jobs` with the slot it served and a 60-minute lease;
a pass the server stopped resumes only for locations not yet called in that slot; a slot missed while the
server was down is caught up within three hours, otherwise it waits for the next one.
`src/server/intelligence/local-intelligence-service.ts` (`discoverWithRetryRule`): one retry after 60 s,
only after HTTP 429, a timeout, a failed connection or a run interrupted mid-call; never after any answer,
including one FairShift can't use. The retry is a run of its own, so it counts toward the daily cap (20
per organisation, unchanged), as every run does whatever started it. `scripts/local-intelligence.ts`
(the manual refresh) uses the same rule. Weather, holiday and ECB jobs are unchanged and make no AI call.

Tests: `tests/unit/scheduler-slots.test.ts` (2) and eight cadence tests replacing one in
`tests/integration/scheduled-feeds.test.ts`: cap reached (no call, not even a retry), 429 → one retry →
stop, a retry that succeeds ends the calls, no response → one retry, an HTTP 500 or an unusable answer →
no retry, success → no retry, manual refresh and its retry counted toward the cap, restart in the same
slot makes no call, a missed slot caught up only while recent, a stopped pass resumed only where no call
got an answer. All providers are fixtures.

**Checkpoint 1 verification.** Full suite with the real-PostgreSQL URL set: **96 files, 1,185 tests, all
passed, 0 skipped** (1,130.05 s), first run, no rerun. On the committed tree (`46abf7f`, extracted to a
clean directory with no local env files): typecheck PASS, lint PASS with 0 warnings, production build
(`next build --webpack` under `env -i` with a dummy database URL) PASS, 15/15 static pages. Pushed.

## Day 5, Checkpoint 2 — South African copy and the DEMO capacity scenario (8 November 2026)

**Copy (step 3).**

- `/demo` (`src/app/demo/page.tsx`): the UK acts (a £200 target; £96 + £25 = £121 and a manager's
  approval) are replaced by the current South African flow: demand and AI-found local signals in rand,
  an offer on preauthorised rand terms, the DEMO disruption, and pay settled after a manager confirms
  the work, through the Pay Agent and PayPal Sandbox in US dollars at the ECB reference rate. The page
  names Jacaranda Table Demo and shows the DEMO act only when the configured demo organisation is that
  business, and mentions earlier completed work only when it exists (`hasEarlierEvidence`).
- Home page worked example (`src/app/components/public-shell.tsx`): £96 + £25 = £121 becomes R45.00 an
  hour × 6 confirmed hours = R270.00, then confirmed → checked → sent to PayPal → paid.
- Kept on purpose: "Plans from £29", "Prices in GBP" and the plan cards state the GBP subscription
  catalogue truthfully; its currency is an open Owner decision. No public page mentions Zettle.
- Not changed, because it is not UK, £ or Zettle copy: `/product`, `/faq` and the home page's loop and
  rules still describe the earlier sales-target bonus and a manager approving each total.
- Documents: no document says the demo has five Johannesburg-area sites (searched the Markdown on every
  branch and the app copy). The README called the demo business "a fictional five-location UK
  fast-casual cafe and dining group"; it now names the five locations (Rosebank and Sandton in
  Johannesburg, Pretoria Central, Durban North, Cape Town Gardens) and says Open-Meteo's free API is for
  non-commercial use only, with a paid plan before commercial use. Open-Meteo's terms, read on 8 November
  2026: "You may only use the free API services for non-commercial purposes." The locked roadmap was not
  edited.

**DEMO capacity scenario (step 4).** `src/server/demo/capacity-scenario.ts`: one synthetic capacity
disruption, "DEMO scenario: planned water interruption (synthetic)", at Rosebank for all of tomorrow
(Johannesburg date), high severity, closure likely. It exists only for the fictional South African
business while that business is a configured demo organisation (sandbox or public demo setting);
any other business, or the same business outside a demo deployment, never has it. It is defined in
code and never stored: the database allows an ACCEPTED local-intelligence signal only with a source
page FairShift checked and the search opened, and a synthetic scenario has neither, so storing it
would fabricate provenance. `resolveLocalIntelligence` takes it as `demo`: it becomes an Owner alert,
an early-notice candidate list and a trading risk on the Manager's plan, never a demand change, and
it uses none of the AI cap. Labels use the existing system (`DataLabel kind="demo"`, new
`DemoScenarioLabel`): "DEMO scenario · Synthetic, made for the demonstration: not a real event, and not
found by AI." The notice it produces is titled "DEMO: …", says it is not a real event, and names no
source; the audit records `demoScenario: true`. The Proof page lists it with the synthetic data.

Surviving re-provisioning: being code, it is untouched by `provisionSaReferenceBusiness`, Reset demo
and discovery runs, and it moves with the date. Limits, stated: the early notice lists casual shifts
already booked at Rosebank for tomorrow, so it needs booked work, and Reset demo cancels such a shift
(it is unconfirmed work); sending is off for public demo personas (existing rule), so confirming needs
a signed-in Owner of the demo business. The scenario books no shift and accepts nothing for anyone.

Tests: `tests/unit/demo-capacity-scenario.test.ts` (2), `tests/integration/demo-capacity-scenario.test.ts`
(2): the alert, the early-notice candidates and confirmation with DEMO wording, nothing stored, no demand
change, survival across re-provisioning and a discovery run, the next day's date, and no scenario for an
ordinary business or outside a demo deployment.

**Browser check, local (headless Chrome over CDP; scratch database; AI schedule off, so no model call;
Pay Agent dry run).** Local fixture: one casual shift at Rosebank on Monday 9 November, 10:00–14:00,
booked for the local casual fixture account through the normal scheduling operations, as
`scripts/seed-sa-runtime.ts` does (a script in the job's scratch directory, not committed).

| As | Page | Observed |
|---|---|---|
| Visitor | `/demo` | "Explore FairShift with Jacaranda Table Demo…", Act 3 · Disruption, rand terms, ECB rate; no "£" |
| Visitor | `/` | Worked example R45.00 an hour, R270.00; no £96, £121 or £200 |
| Demo Owner | `/owner`, `/owner/forecast` | Alert "Rosebank: DEMO scenario: planned water interruption (synthetic)", Closure likely, the DEMO label, the booked casual worker and shift, "Sending notices is turned off in the public demo." |
| Demo Owner | `/owner/proof` | DEMO scenario listed with the synthetic data; no account email, key or token |
| Demo Manager | `/manager/plan?date=2026-11-09` | "A DEMO scenario shows something that would stop this location trading", the DEMO label, the 05:00/17:00 cadence copy |
| Owner account (signed in) | `/owner` | "Send early notice to 1 casual worker" with the DEMO confirmation box; confirmed → `status=early-notice-sent`, "early notice sent", "Everyone this affects has had the early notice." |
| Casual's own account | `/account`, `/worker/shifts` | "DEMO: Your shift on Monday 9 November may not go ahead", "…not a real event", "doesn’t cancel your shift"; the shift still booked |
| Demo Owner | Reset demo, then `/owner` | Alert still shown; "No allocated casual shift falls in this time" (the reset cancelled the booked shift) |
| — | `pnpm reference:sa` (re-provisioning), then `/owner`, `/manager/plan` | Alert and plan risk still shown; 0 of 227,271 reference rows inserted, existing rows kept |

Every page: 0 console errors. The notice's email was never attempted (delivery `PENDING`, no provider
ID): FairShift never emails the public demo organisation's activity. Not done: `/account` is closed to
demo personas, so the worker's notice was read through the casual fixture's own account.

**Checkpoint 2 verification.** Full suite with the real-PostgreSQL URL set: **98 files, 1,189 tests, all
passed, 0 skipped** (2,017.98 s, slower than checkpoint 1 under other load on the machine), first run, no
rerun. Typecheck, lint and the isolated production build ran on the committed tree before the push.

## FS-SITE-COPY-SA-001 — public site and /demo copy (8 November 2026)

Copy only, on `submission`; no server logic, schema, migration, pricing plan or PayPal change.

**Audit (read-only, before editing).** Between `origin/fs-square-live-001` (`9571b5d`, what Render
deploys) and `submission`, the public marketing files differed only in `/demo` and the home worked
example (already SA copy from Day 5 checkpoint 2); home, `/product`, `/faq` and `/pricing` were the
same on both. Conflicts found there: the sales-target bonus as the pay model (home loop, jobs, roles,
rules; `/product` "Worker acceptance", "Attributed performance", "Incentives"; FAQ pay, attribution
and worker answers; plan card "Shift offers and live targets"), "manager approves every total" and
"approved total" wording (home, `/product` "Manager approval", FAQ), and no tips, no ZAR→USD and no
local demand signals anywhere. No public page mentioned Zettle or the UK, and no location name was
wrong.

**Changes.** Home (`src/app/page.tsx`): hero, loop, the four jobs (Track becomes Tips), roles and
rules. `/product`: new Local signals, Confirmed work, Pay Agent and Tips steps; Worker acceptance and
PayPal payout rewritten; the target, incentive and manager-approval steps removed. `/faq`: pay,
approval, double payment, currency, tips, sales source, refunds, forecast, AI and worker answers.
Plan cards: two feature lines. `/demo`: the five locations named, local signals, the rate locked at
reservation. Sources: DEC-SA-011, FS-APPROVER-DEC-001, DEC-SA-012, FS-TIP-DEC-002,
FS-TIP-AGENT-DEC-001, FS-DEMAND-CONTEXT-001 and the 8 November demand-signal decisions.

**Kept as instructed:** the tagline, the 30-day free trial, "AI suggests, people decide" and "Paid
only when PayPal confirms it".

**Worked example.** No casual pay term was recorded, so the Owner was asked and approved R45.00 an
hour as the demo value (recorded verbatim in `docs/FS-HACK-SA-AMENDMENT-001.md` section 5). The home
example keeps 6 h × R45.00 = R270.00 and now cites it, and says the rate is the latest ECB rate,
locked when the payout is reserved.

**Left for the Owner:** pricing currency. "Plans from £29 a month", "Prices in GBP" and the plan
prices are unchanged.

**Verification.** Typecheck PASS; lint PASS, 0 warnings; isolated production build PASS (15/15 static
pages). Full suite with the real-PostgreSQL URL: **98 files, 1,189 tests, all passed, 0 skipped**
(909.91 s) on the third run. The first run was stopped to finish the edits; the second had one 30 s
timeout in `pay-agent-processing` while the Mac idle-slept from 09:14 to 09:22, so the third ran under
`caffeinate -i`. Headless Chrome against the local server: `/`, `/product`, `/faq`, `/pricing` and
`/demo` show the new copy, none shows "bonus", "sales target" or "approves every total", and every page
has 0 console errors.

## Day 5b, Checkpoint 1 — Owner decisions, USD plans, rand-first pricing (8 November 2026)

Owner-supplied work package "FairShift — Day 5b: hosted deploy, USD plans, demo open (SANDBOX ONLY)".
The package named HEAD `672894b`; the branch was at `f432d9e` (FS-SITE-COPY-SA-001, already pushed),
so the work was built on `f432d9e`.

**Decisions (step 1).** The five Owner decisions of 8 November 2026 (staffing gate amended to "an Owner
or a Manager", scope, currency, demo pricing, VAT) are recorded verbatim, dated, in
`docs/FS-HACK-SA-AMENDMENT-001.md` section 5. A dated notice on the earlier staffing-gate bullet points
to the amendment, and a dated pointer sits under the specification's GBP pricing table. The
"AI LOCAL INTELLIGENCE (8 Nov)" text was not in the package; the Owner supplied it later the same day,
and it is recorded verbatim ahead of the later 8 November records, with the Owner's one-line note that
those later decisions win where they overlap (cadence, part g; staffing gate, part e; bands, parts c
and e). No code was changed for it. Code already
matches the amended gate: `decideLocalAdjustments`, `createRequirement`, allocation and
`confirmWork` accept an Owner as well as a Manager.

**USD plans (step 2).** PayPal Sandbox, existing product `PROD-8S5740580A111492L` ("FairShift"). Four
new plans, each a free 30-day `TRIAL` cycle (sequence 1) then a `REGULAR` cycle (sequence 2), created by
`scripts/provision-paypal-subscriptions.ts --apply`, then fetched back and checked with
`assertCommercialPlan` (active, USD, the Owner's amount, no setup fee, no tax):

| Plan | PayPal plan ID | PayPal bills | Price shown |
|---|---|---|---|
| Venue Monthly (USD), 30-day trial | `P-5U646656F53669406NLYFG4A` | US$30.17 a month | R499/month incl. 15% VAT |
| Venue Annual (USD), 30-day trial | `P-03N78956GR621793BNLYFG4Q` | US$301.73 a year | R4,990/year incl. 15% VAT |
| Group Monthly (USD), 30-day trial | `P-8D21565845075562BNLYFG5A` | US$69.48 a month | R1,149/month incl. 15% VAT |
| Group Annual (USD), 30-day trial | `P-5B101351GN843403KNLYFG5I` | US$694.76 a year | R11,490/year incl. 15% VAT |

A read-only run afterwards: 12 FairShift plans valid, none missing. The local `.env.local` now holds the
four USD IDs (old values in a git-ignored backup); the Render variables were switched in step 5. A
plan's currency can't change, so checkout accepts only these USD plans, while subscriptions on the eight
earlier GBP plans (trial and no-trial) still reconcile. **GBP plans not deactivated:** a Sandbox
subscription created on 3 November 2026 on "Single Outlet Monthly, 30-day trial"
(`P-104896034C256045HNLU2AGQ`) was active in its trial (`SUBSCRIPTION_TRIAL_EVIDENCE.md`), and PayPal
has no API that lists a plan's subscriptions, so no GBP plan can be shown to have no dependants. All
eight stay `ACTIVE`. FairShift's local database has no subscription rows. The hosted one has three: one
`ACTIVE` on the GBP "Multi Outlet Monthly" no-trial plan (`P-1M6317095M539293XNLIV3XI`), which confirms
a dependant, and two `CANCELLED`. The Owner's dollar amounts are the rand prices divided by 16.5382, to the nearest cent
(499 → 30.1726; 4,990 → 301.7257; 1,149 → 69.4755; 11,490 → 694.7552). They are fixed in the catalogue,
never computed at checkout. Payout conversion (DEC-SA-012) rounds down and is unchanged.

Plan selection by currency: `billingCurrencyFor(home)` returns the home currency where PayPal supports
it (PayPal's REST currency codes) and USD otherwise. The price list's home currency is ZAR, which PayPal
doesn't support, so every plan bills in USD.

Copy: `/pricing` and `/subscribe` plan cards show "Venue" (1 location) and "Group" (up to 5 locations),
the rand price incl. 15% VAT as the headline, and "30 days free, then R499/month incl. 15% VAT — billed
by PayPal as US$30.17; your bank or PayPal converts at its own rate." No converted figure is shown as
the charge (the annual monthly-equivalent figure is gone). The footnote says workers are never charged
and VAT never applies to worker earnings or tips. The home page's price teaser and the Owner's
subscription panel use the same names.

**Card option.** PayPal JS SDK, Sandbox client, `intent=subscription&vault=true&currency=USD`, headless
Chrome: the `card` funding source is eligible and the "Debit or Credit Card" button rendered for
buyer countries ZA, US and GB (US also offered PayPal Credit). FairShift's checkout uses PayPal's hosted
approval page (a redirect), not the SDK buttons. **Sandbox business account country: NOT VERIFIED.**
This app's credentials can't read it: userinfo returns only an ID, balances answered 403 and seller
status 404. The only country field in the SDK's responses (GB) comes from PayPal's logging endpoint and
follows the browser locale, so it isn't evidence. The country is shown in the PayPal Developer
Dashboard under Sandbox accounts.

**Payout checks (report only, nothing changed).** VERIFIED by reading the code and its tests: the live
engine (`src/server/payments/work-payouts.ts`, `payoutStatusFromProvider` and `reconciledStatus`) marks
a payout `PAID` only on the item's `transaction_status` `SUCCESS` with the amount and currency FairShift
sent. A batch `SUCCESS` without the item stays `PROCESSING`. `sender_batch_id` is deterministic:
`FSWP-B-<payable ID>` for casual pay and `FSTP-B-<tip line ID>` for tips, one reservation per payable or
line (unique indexes), reused on every retry. The legacy incentive demo path (`src/server/incentives/demo.ts`)
still maps a status that falls back to the batch status when the item is missing, but its server
actions are hard-disabled ("Legacy incentive payout is unavailable"), so it was left alone.

**Tests.** `tests/unit/subscription-catalogue.test.ts` (catalogue, plan selection by currency, provider
validation, reconciliation of the GBP plans), `tests/unit/no-vat-on-earnings.test.ts` (no VAT on a
payable, tip shares or the USD payout leg; only the price list knows VAT),
`tests/integration/subscription-negative.test.ts` (ERRSUB032/033/034/039 each on one of the four new
USD plan IDs; ERRSUB044/046; no second subscription after a double click, after an abandoned approval
retried on another plan, after simultaneous clicks on two plans, or after activation),
`tests/integration/subscriptions.test.ts` (both GBP plan shapes refused at checkout, still reconciled),
and the copy assertions in `public-onboarding-ui.test.ts` and `auth-request.test.ts`.

**Checkpoint 1 verification.** On the committed tree (`0fdeea7`, extracted to a clean directory with no
local env files, real-PostgreSQL URL set): full suite **99 files, 1,205 tests, all passed, 0 skipped**
(1,123.08 s), first run. Typecheck PASS; lint PASS, 0 warnings; isolated production build
(`next build --webpack` under `env -i`, dummy database URL) PASS. Pushed; Render deploy
`dep-dbo5nc142hec73d1gpv0` of `0fdeea7` live at 11:25:22 UTC.

## Day 5b, Checkpoint 2 — product copy and the demo booking (8 November 2026)

**Copy (step 3).** FS-SITE-COPY-SA-001 (`f432d9e`) had already moved `/product` and `/faq` to the current
model. This step added the plan prices in rand first with the US dollar amounts PayPal bills (FAQ "What
does a plan cost?", product "What it costs", both read from the catalogue), the Venue and Group names,
VAT on the plan only and never on worker earnings or tips, "workers are never charged", rand-first
worker pay with the dollar amount and rate as a separate labelled line, and the amended staffing gate:
"an Owner or a manager accepts" on `/product`, `/faq`, the home page and `/demo`. Work is confirmed "by a
manager or the Owner", and the person who confirms is the approver of record. The server actions accept
OWNER and MANAGER, and `approvedBy` is the confirming user. No page claims "no conversion fees", and a
test now forbids it on the home page, `/product`, `/faq` and `/pricing`. The app's optional Owner-set
sales-target bonus on work policies is a product feature and is untouched; no public page describes the
old bonus-and-manager-approval model. Remaining "£" copy: the Square Sandbox demo panel for a
Square-connected location (`src/app/manager/square-panel.tsx`), shown only outside the public demo; not
touched.

**Demo booking (step 4).** `ensureDemoBooking` (`src/server/demo/booking.ts`), for the fictional South
African business only: a casual shift at Rosebank tomorrow (Johannesburg date), 10:00–14:00, on "Casual
floor terms" at R45.00 an hour (the Owner-approved demo value), offered to, accepted by and allocated to
a synthetic casual worker (reserved test address) through the normal scheduling operations, in one
transaction under an advisory lock. An existing booking for that date is kept. Two callers:

- Demo setup: new `provisionSaDemo` (`src/server/demo/provision.ts`, `pnpm demo:sa`) makes the reference
  business, a synthetic Owner, the Rosebank Manager, a Rosebank casual worker and the booking. The
  Manager and worker are invited only once the business is entitled by its PayPal Sandbox subscription,
  and it creates no subscription.
- Reset demo closes unconfirmed work as before, then books tomorrow again for the demo Worker persona.

The public demo's Owner persona can now send the DEMO scenario's early notice: only in the configured
demo business, only for the DEMO scenario (a genuine finding stays closed to demo visitors), only to
workers with reserved test addresses, rate-limited per demo group (20), audited with the persona and
group, and never emailed. The action skips dispatch, and dispatch already refuses the demo business's
activity.

Tests: `tests/integration/demo-booking.test.ts`. Demo setup waits for the subscription, then books
2 December 10:00–14:00 SAST once, however often it runs. The demo Owner persona's notice reaches only
the synthetic worker, with the delivery never attempted. Reset demo cancels the booking and books again,
so a fresh notice can be sent. Re-provisioning keeps the new booking. A day later the booking moves to
3 December with the scenario. The notice is refused for a genuine finding, for another business and for
a worker with a real address. Synthetic-address recognition is covered too. Copy assertions are in
`public-onboarding-ui.test.ts`.

**Checkpoint 2 verification.** On the committed tree (`99938e2`, extracted to a clean directory with no
local env files, real-PostgreSQL URL set): full suite **100 files, 1,210 tests, all passed, 0 skipped**
(1,352.58 s), first run. Typecheck PASS; lint PASS, 0 warnings; isolated production build PASS, 15/15
static pages. The documents commit that follows changes only `docs/`, which no test reads.
