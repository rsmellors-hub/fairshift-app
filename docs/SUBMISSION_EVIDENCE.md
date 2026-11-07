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
