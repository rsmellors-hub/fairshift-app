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
