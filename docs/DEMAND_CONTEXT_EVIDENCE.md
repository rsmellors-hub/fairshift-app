Working note from the build. It may describe an earlier state. The README and docs/SUBMISSION_EVIDENCE.md describe the submitted build.

# Contextual Demand Evidence (FS-DEMAND-CONTEXT-001)

**Status: implemented and verified locally, with genuine OpenAI responses. Not deployed.** A Manager can see a location's deterministic baseline and the context FairShift holds, ask AI for a bounded scenario, and accept or dismiss it. Only acceptance changes staffing, and the recalculation carries into Fill Shifts.

Owner decision and fixed mapping: FS-DEMAND-CONTEXT-DEC-001, in [`FAIRSHIFT_PRODUCT_UX_SPEC.md`](FAIRSHIFT_PRODUCT_UX_SPEC.md), section 1.

## 1. What the evidence is

| Kind | What it covers | Where |
|---|---|---|
| **GENUINE PROVIDER** | OpenAI `gpt-6-luna` responses through the real server actions, on labelled synthetic reference history, on a throwaway PostgreSQL database and a local production build | Section 4, `evidence/fs-demand-context-001/genuine-ai-records.json`, screenshots `05`, `06`, `10`, `11` |
| **GENUINE PROVIDER FAILURE** | A real 401 from OpenAI, using a key it refuses | Section 6, screenshot `04` |
| **FIXTURE** | Scripted model answers in automated tests. Never provider evidence | `tests/integration/demand-context.test.ts` |

The Manager-entered notes in the genuine run are invented rehearsal text about the fictional company, and each says so. No event is real or verified.

## 2. Baseline before context

Calculated through the real loader, database and engine on PostgreSQL, on the real clock, with data through 1 Nov 2026, for Tue 3 to Mon 9 Nov 2026:

| Frozen output | Expected | Found |
|---|---|---|
| Casual hours | 64.25 | **64.25** |
| Opportunity Demand windows | 32 | **32** |
| Location-days with a casual requirement | 20 of 35 | **20 of 35** |

The workload policy, reference history, coverage and forecast parameters were not changed. With no accepted scenario, every staffing figure is the same as before this package, and an automated test holds these three outputs through the real loader.

## 3. Signals and their provenance

| Signal | How it's made | Label shown | Notes |
|---|---|---|---|
| Momentum | Transactions per observed trading day, latest 28 days against the prior 28, from the location's own chosen history. Needs at least 21 observed days in each period. Valid for 14 days after the data cutoff | "Calculated from sales history, not AI" | Keeps both periods, counts and change. Under 1% reads as about level, with its figure |
| Manager-entered | Date range of up to 14 days, a description of up to 200 characters, and an expected direction. Records who entered it and when | "Manager-entered context, not independently verified" | Can be withdrawn, but not edited or deleted |
| UK bank holiday | Committed snapshot of `https://www.gov.uk/bank-holidays.json`, retrieved 2 Nov 2026, with the response's SHA-256 recorded | "Official GOV.UK dates, stored snapshot" | Carries no direction, because its effect isn't known |

**Nation.** Holidays differ by nation, so one is resolved only when the location record states England, Wales, Scotland or Northern Ireland. A county, a blank or another country reads "unknown". FairShift doesn't guess from a city.

A missing signal is shown as unknown, never as normal. With no signal for a day the model isn't called. Signals never edit sales history. School holidays are **not implemented**. Weather, event feeds and bookings were not implemented in this package, and were added by [`CONTEXT_SIGNALS_EVIDENCE.md`](CONTEXT_SIGNALS_EVIDENCE.md).

## 4. Genuine AI run

Chosen before any answer was seen: **Leeds, Wed 4 Nov**, the strongest window already recorded at the Manager's location in `HOSPITALITY_POLICY_FREEZE_EVIDENCE.md`. Nothing was retuned after the answers.

| Date | Signals supplied | Genuine answer | Cited | Manager |
|---|---|---|---|---|
| Wed 4 Nov | Momentum +2.3%; note about a trade conference next door (UP) | `MINOR_UP` | The note only | **Accepted** |
| Thu 5 Nov | Momentum +2.3%; note about a road closure (DOWN) | `MINOR_DOWN` | The note only | **Dismissed** |
| Fri 6 Nov | Momentum +2.3% only | `NONE` | Momentum | Left undecided |

The model's reason on Wed 4 Nov: "The manager-entered note describes a trade conference next door with an expected lunchtime crowd, a specific reason for higher demand on this date. The note is unverified, so the smaller adjustment is appropriate."

Each stored record holds the input, its fingerprint, the validated output, the provider's response ID and the responding model. The model chose the smaller scenario both times, and declined to adjust on momentum alone. Three answers show the path works. They say nothing about how good its judgement is.

An earlier walkthrough on a since-deleted database also called the real model. It was discarded because of a bug in the walkthrough script, not in the product. Its Wed 4 Nov and Fri 6 Nov answers were the same scenarios.

## 5. Before and after acceptance

All on real figures, Leeds, Wed 4 Nov, `MINOR_UP` = +5%:

| | Baseline | Accepted |
|---|---|---|
| Expected transactions, day | 155 | **162** |
| Required staff capacity, day | 26.75 h | **27.5 h** |
| Casual requirement, day | 4.75 h | **5.5 h** |
| Window 12:00–14:00: transactions / required / casual | 62 / 9.25 h / 3.25 h | **66 / 9.75 h / 3.75 h** |
| Window 08:00–10:00: casual | 1.5 h | **1.75 h** |
| Leeds week: casual | 20.25 h | **21 h** |
| Company week: casual | 64.25 h | **65 h** |

The difference is modest because the assumption is small, and it is shown as it came out.

**Forecast → Fill Shifts.** The Manager followed the path into Fill Shifts, which showed the recalculated window and said it included the accepted scenario. A shift created through the real form froze the same figures, with the scenario, in its "Why this shift was created" record. The server recalculates this at creation, and a forged or stale form value can't carry (automated tests).

**Stale acceptance, observed live.** A further note on the same day changed the evidence. The day read "Needs review", returned to 155 transactions and 3.25 h in Fill Shifts, and said why. Withdrawing that note restored the same evidence, so the acceptance applied again.

## 6. AI failure falls back to the baseline

| Condition | Evidence | Result |
|---|---|---|
| No key | **Live**, screenshot `02` | "AI isn't configured". No proposal, baseline and Fill Shifts work |
| Key refused | **Live genuine 401**, screenshot `04` | Recorded as `HTTP_401`. No scenario, same figures, Fill Shifts works, retry offered |
| Timeout, 503, thrown error, malformed JSON | Fixture | Recorded, baseline identical |
| Extra numeric field, unknown scenario, missing citation, invented citation | Fixture | Rejected whole, baseline identical |
| Contextual tables unreadable | Fixture, with a table dropped | Page says context is unavailable, planning and staffing identical |

## 7. Controls

- **Output contract:** exactly `scenario`, `citedSignalIds` and `reason`. Strict Structured Outputs, then a strict parser.
- **Validator rejects:** malformed output, unknown keys, unknown scenario, unknown or repeated citations, another organisation's or location's signal, a signal invalid for the date or withdrawn, non-`NONE` with no relevant citation, any figure in the reason, and input that changed during the call.
- **Numbers:** `applyDemandAdjustment` refuses any value outside the policy. The database refuses a decision whose scenario and percentage don't match the policy or its proposal.
- **Model input:** an opaque location key and aggregate demand. No regular cover or staffing gap, no organisation, location or person identifiers. A Manager's note is sent as data, the instructions tell the model to ignore anything in it that reads as an instruction, and the form warns against entering names.
- **Decisions:** append-only, with Manager identity and role, time, scenario, input and output fingerprints, policy version and signal references. The form supplies only the proposal ID.
- **Scope:** every action takes its location from the session. Workers are refused. Actions stay closed to the public demo.
- **Audit:** additions, withdrawals, proposals, failures and decisions each write an audit event.

## 8. Screenshots

In `evidence/fs-demand-context-001/`: `01` forecast page, `02` baseline with AI not configured, `03` Manager-entered context, `04` genuine provider failure, `05` genuine proposal, `06` accepted and recalculated, `07` full page with accepted scenario, `08` Fill Shifts, `09` frozen reason, `10` genuine `NONE` on momentum alone, `11` genuine dismissal, `12` stale acceptance, `13` Owner forecast, `w1024`, `w768`, `w390` narrower layouts. The walkthrough had no console errors and no page overflow.

## 9. Claims

**Supported after this package:**

> FairShift's AI weighs supplied contextual signals against a store's demand baseline and proposes a bounded, cited scenario. A Manager decides whether to accept it, and FairShift then recalculates the labour requirement deterministically.

**Not supported:** AI forecasts demand autonomously; AI determines staffing, creates shifts, chooses workers, controls pay, calculates incentives, allocates tips, approves payments or triggers payouts; contextual effects are learned or calibrated; +5% or +10% is a measured effect; Manager-entered events are externally verified; weather awareness; measured accuracy for contextual scenarios.

## 10. Limitations

- **Not deployed.** Migration `0023_demand_context` is additive and has not been applied to hosted. Without it, planning carries on from the baseline and the panel says context is unavailable.
- **The public demo is read-only here.** Its sessions can't add context, ask AI or decide. A judge using it would need a prepared accepted state, or a separate decision to open these actions.
- **Bank holidays need a stated nation.** The onboarding field is free text ("Province / state"), so a county reads as unknown. The genuine run's locations state England. No holiday falls in the rehearsal week, so a holiday signal was tested by fixture only and has not reached the model.
- **Minor and moderate have no calibration.** The model picks by judgement within fixed policy.
- **Momentum partly overlaps the baseline,** which already weights recent weeks. The instructions say so, but the validator doesn't forbid an adjustment on momentum alone.
- **An Owner can decide too,** on their selected location, as with shift creation. The role is recorded.
- **The staffing assessment panel** reads accepted figures and has a marker on that day, but its instructions were not changed to explain the marker, to avoid invalidating stored assessments.
- **Not run in one sitting** with Square attribution, approval and PayPal. No Square, PayPal or Zettle call was made, and tips remain unimplemented.

## 11. Golden Path status

| Step | Before | After |
|---|---|---|
| 1–7. History, commercial and operational forecast, time of day, frozen capacity, regular cover, Opportunity Demand | VERIFIED locally | VERIFIED locally, unchanged |
| 8. Contextual signal | NOT IMPLEMENTED | **VERIFIED locally** (holiday by fixture only) |
| 9. AI bounded scenario | NOT IMPLEMENTED | **VERIFIED locally, genuine provider** |
| 10. Manager acceptance | NOT IMPLEMENTED | **VERIFIED locally** |
| 11. Deterministic recalculation | NOT IMPLEMENTED | **VERIFIED locally** |
| 12. Forecast → Fill Shifts | VERIFIED locally on baseline | **VERIFIED locally, baseline and accepted** |
| Hosted, demo-ready | Not established | **Not established** |

## 12. Quality gates

Run on one frozen tree: a checksum of `src`, `tests`, `scripts` and `drizzle` matched before and after the final test run. Only documentation changed afterwards, and the final walkthrough screenshots predate one change: the Owner note, whose screenshot `13` comes from the final build.

| Check | Result |
|---|---|
| Full test suite | 67 files, 775 tests passed, 583 s |
| New tests | `tests/unit/demand-context.test.ts`, `tests/integration/demand-context.test.ts` |
| Changed test | `owner-onboarding.test.ts`: pinned migration count 23 → 24, for the new additive migration |
| Typecheck | `tsc --noEmit`, exit 0 |
| Lint | `eslint .`, exit 0 |
| Smoke | `pnpm smoke:manager`, PASS |
| Production build | Exit 0, from a copy with no `.env` files, with `DATABASE_URL` at a dead local port and no provider keys |
| Browser walkthrough | Headless Chrome on a local production build, throwaway PostgreSQL. No console errors, no overflow at 1280, 1024, 768 and 390 px. Screens `06` and `w390` were also checked by eye |

The first full-suite run had one failure, that pinned count. It was fixed and the suite rerun in full.

The OpenAI key was read only for the server process in the genuine run. It wasn't printed, logged or stored.
