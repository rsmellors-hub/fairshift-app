# Workload Intelligence Evidence (FS-WORKLOAD-INTELLIGENCE-001)

**Status: implemented and verified locally. Not deployed.** FairShift now forecasts each location's sales and its transaction workload by time of day, and compares that workload with the business's own policy and regular cover. The reference company is now hospitality. Its service capacity and minimum cover are **awaiting an Owner decision**, so its casual requirement correctly shows as "Configuration required". Status terms follow `AGENTS.md` §8. Reference data is **SIMULATED**.

## 1. Preflight

| Item | Value |
|---|---|
| Directory and branch | `/Users/ryanmellors/Projects/Fairshift/app`, `fs-square-live-001` |
| Starting HEAD | `e849eba5f076405f15efac75b38ac0cd39db91e1`, as expected |
| Starting tree | FS-REFERENCE-REFRESH-001 uncommitted: 11 modified files, 3 untracked items, plus `.claude/`. No hospitality work existed |
| Newest migration at start | `0021` |

| Expected | Found | Treatment |
|---|---|---|
| FS-HACK-MASTER-001 available | Not in the repository | Worked from the dated amendment |
| An existing evidence-led time-window approach | None. Staffing was daily and revenue-based | Built the smallest version (section 6) |
| An existing workload policy | Only `labour_policies` (£ per labour hour) | Sibling table; old one retired from the active path |

## 2. Authority reconciliation

The product specification's section 1 now carries the dated amendment. Historical evidence wasn't rewritten: earlier records only gained a pointer here.

| Class | Item | What happened |
|---|---|---|
| A. Reusable | Completed-day clock guard, deterministic RNG, canonical ingestion, version mixing guard, negative tests | Kept and applied to hospitality |
| B. Superseded | Retail stores as the active company, £100 per labour hour reference value, retail rotas, "retail managers" in the AI prompt | Replaced |
| C. Historical | `REFERENCE_REFRESH_EVIDENCE.md`, its screenshots, `uk-retail.ts` (v2), its unit tests | Kept and committed as superseded. The generator stays reproducible and can't be loaded |
| D. Not touched | `.claude/`, worker, Bryntum, Square, incentive, approval and PayPal code | Unchanged |
| E. Owner decision | Reference service capacity and minimum cover | Left unset |

Every file from the refresh:

| File | Outcome |
|---|---|
| `src/server/reference/uk-retail.ts` | Kept as v2, marked superseded |
| `src/server/reference/provision.ts` | Clock guard kept; now loads hospitality and sets no policy |
| `scripts/load-reference-history.ts` | Kept; names the active dataset |
| `tests/unit/reference-history.test.ts` | Kept for the retail dataset |
| `tests/integration/reference-refresh.test.ts` | Kept and moved to hospitality; negative tests preserved |
| `reference-history`, `staffing`, `weekly-forecast`, `ai-staffing`, `commerce-independence`, `owner-reference-pages` integration tests | Moved to the new path |
| `docs/REFERENCE_REFRESH_EVIDENCE.md`, `docs/evidence/fs-reference-refresh-001/` | Kept unchanged except for a pointer |
| `docs/REFERENCE_COMMERCE_FORECAST_EVIDENCE.md` | Pointer only |

`tests/unit/staffing.test.ts` tested the removed revenue calculation. `tests/unit/workload.test.ts` replaces it.

## 3. Reference company

Dataset **`uk-hospitality-v1`**, in `src/server/reference/uk-hospitality.ts`: one fictional five-location casual-dining and café group, GBP, Europe/London. Calendar: Mon 3 Nov 2025 to Sun 31 Jan 2027, 65 complete weeks. The loader never goes past the latest completed day. It enters through the canonical boundary with `REFERENCE` provenance.

| Code | Location anchor | Profile | Design | Base bills a day | Mean bill |
|---|---|---|---|---|---|
| UK01 | Leeds | C, central business district | Strong weekday breakfast and lunch, quiet weekends | 130 | £10.50 |
| UK02 | Manchester | A, stadium district | Evening-led, strong Friday and Saturday | 110 | £21.00 |
| UK03 | Birmingham | E, shopping centre | Stronger weekends and bank holidays, long afternoon | 140 | £13.50 |
| UK04 | Brighton | B, waterfront and outdoor | Weekend-led, warm-month season | 100 | £17.00 |
| UK05 | London Stratford | D, station and commuter | Sharp morning and early-evening peaks, low bills | 220 | £7.50 |

These are hand-set **synthetic design characteristics**, not measurements. FairShift learns nothing causal from them.

**Method:** a SHA-256 seed of version, venue, date and purpose feeds a mulberry32 stream. Daily bills are base × day factor × blended month season × slight growth × noise. Each bill falls in an hour by the venue's curve. Its value comes from a lognormal draw around the venue's mean, scaled by hour, so value and count don't move in lockstep.

**Stated assumptions of the fictional group:** factual England and Wales bank holidays use Sunday hours and a venue factor. Every venue closes on Christmas Day. Trading hours and regular cover differ by venue and are hand-set reference configuration.

**Not generated:** events, weather, bookings, covers, guest counts, tables, menu items, kitchen tickets, tips, recipes, inventory or food costs. A test checks the generator's output and source for this.

## 4. Commercial and operational forecasts are separate

| | Commercial | Operational |
|---|---|---|
| Question | What sales value is expected? | How many transactions, when, on what evidence? |
| Input | Daily sales | Timed transactions, per 15-minute slot, from the location's chosen source |
| Method | `comparable-days-recency-v1`, unchanged | `transaction-windows-recency-v1`: the same matching-weekday, recency-weighted family, with isolated highs capped, by window |
| Effect on staffing | None | Sets the workload |

An observed day with nothing in a window counts as zero there. A day with no records is unknown and absent. A row with no real recorded time is excluded, which gives `NO_TIMED_HISTORY` rather than invented timing. Transactions the history shows outside stated hours are named on screen, not silently lost.

## 5. Workload policy

Table `workload_policies`, a sibling of `labour_policies`: organisation default with optional location override, versioned, append-only, immutable by trigger. A version holds both values, so a policy is complete or absent.

- `transactions_per_staff_hour`: whole number, 1 to 1000
- `minimum_staff_while_open`: whole number, 0 to 100 (a configured zero is valid)

FairShift has no default. Loading reference data sets no policy.

```
workload minutes  = expected transactions / capacity × 60, rounded up to 15 minutes
minimum minutes   = minimum staff × open minutes
required          = max(workload, minimum)
remaining         = max(0, required - regular overlap - allocated casual overlap)
```

`labour_policies` and `regular_staff_coverage` are retained and readable. Nothing writes or reads them now. A test confirms an old revenue rate alone produces no staffing figure.

### Still open: Owner decision required

**Reference service capacity and reference minimum open coverage have no value.** None was invented, and none was reused from retail.

The table below is information for that decision, not a recommendation. It was calculated for Tue 3 to Mon 9 Nov 2026 from data through 1 Nov, on the current hand-set cover.

| Capacity (transactions per staff hour) | Min 0 | Min 1 | Min 2 | Windows at min 1 |
|---|---|---|---|---|
| 4 | 397.5 h | 397.5 h | 404.75 h | 57 |
| 6 | 115.5 h | 115.5 h | 127.25 h | 45 |
| 8 | 37 h | 37 h | 50.75 h | 25 |
| 10 | 7 h | 7 h | 21.5 h | 15 |
| 12 | 0.5 h | 0.5 h | 15.25 h | 2 |
| 15 | 0 h | 0 h | 15 h | 0 |
| 20 | 0 h | 0 h | 15 h | 0 |

The regular cover was hand-set before any capacity existed. If the demo needs a particular requirement, the Owner should judge cover and capacity together. Choosing a capacity because it makes this table look good would be the tuning the amendment forbids.

## 6. Time windows and trading hours

Calculations use minutes after local midnight and real instants, with overlap arithmetic. There's no breakfast, lunch or dinner type in the calculation; a test confirms the words are absent from `workload.ts`. Morning, Lunch, Afternoon and Evening are display labels, shown only for reference history and only on stretches of up to five hours.

Open time is cut into clock-hour **planning blocks**, clipped to trading hours. Adjacent blocks in the same state form a **service period**: Covered, Needs cover or Filled by casual work. Windows therefore come from the evidence and the business's own policy.

Trading hours (`outlet_trading_hours`) are per location and weekday. No row means not set, and an empty list means stated closed. Split openings are allowed. Overlapping, malformed or off-quarter-hour windows are refused.

## 7. Regular coverage

`regular_coverage_windows` holds start, end and headcount per location and weekday. No row means not set, and an empty list is a stated zero. It's capacity input, not a roster: no rostering, timesheets, leave or staff accounts. Cover outside trading hours isn't counted.

## 8. Opportunity Demand

`OpportunityDemand` (`src/server/intelligence/opportunity.ts`) is a typed concept derived on read. It has organisation, location, local date, window start and end, expected transactions with range and support, commercial context, required capacity, regular and allocated casual cover, remaining requirement, peak people needed, method and policy versions, provenance, and state (Open or Filled). Demand itself isn't stored.

## 9. Forecast to Fill Shifts

Manager Forecast & staffing links to `/manager/fill?date=…&window=…`. The form starts with the window's times and peak people needed, and the Manager can change them. Pay and worker eligibility stay with the existing work policy and worker rules.

The form carries only a pointer. `createShiftFromOpportunity` recalculates the figures on the server for the session's own location and refuses a stale, forged, non-overlapping or other-location opportunity. It then writes `shift_opportunity_evidence`, a frozen record of why the shift exists, in the same transaction. A trigger blocks changes and deletion and enforces the shift's location and organisation. Pay never reads it. Workers never see it.

Shifts can still be created by hand with no opportunity.

## 10. Migration

`drizzle/0022_early_cloak.sql` is additive: four new tables, four triggers, no drops, no data changes, no edits to earlier migrations. Applied on a scratch PostgreSQL 15 database and in every test database. **Not applied to hosted.**

## 11. AI boundary

The AI contract moved to `fs-staffing-ai-input-v3` and `fs-staffing-ai-output-v3`. It now also carries expected transactions, opportunity windows and method and policy versions. Fingerprint, staleness and validation controls are unchanged, so older stored assessments correctly read as stale.

The output schema has no field that could set demand, capacity, minimum cover, coverage, shifts, workers, pay, approval or payouts. The prompt forbids suggesting a capacity value. **No OpenAI call was made.** A real AI explanation of this dataset is **NOT VERIFIED**. Contextual AI was **not implemented**.

Future direction only, for FS-DEMAND-CONTEXT-001: historical momentum, manager-entered known demand, public holidays, local events, weather. Its target is operational demand by window (`PlanningBlock`), so a later accepted adjustment can feed the same capacity calculation.

## 12. Test contract

| # | Requirement | Where |
|---|---|---|
| 1–4 | Same £ different counts; same count different £; average-bill rise; volume rise and floor | `tests/unit/workload.test.ts` |
| 5–8 | Missing policy, missing minimum cover, missing hours, configured zero versus missing | `workload.test.ts`, `integration/business-policy.test.ts` |
| 9–12 | Overlap, surplus can't cancel shortage, partial casual overlap, malformed windows | `workload.test.ts`, `business-policy.test.ts` |
| 13–14 | Cross-location and cross-tenant | `integration/workload-opportunity.test.ts`, `business-policy.test.ts` |
| 15 | Future and unfinished commerce | `integration/reference-refresh.test.ts` |
| 16–18 | Deterministic, five different profiles, no fake signals | `tests/unit/reference-hospitality.test.ts` |
| 19–20 | Fill Shifts carry; evidence can't change accepted pay | `workload-opportunity.test.ts` |
| 21 | Worker eligibility | `scheduling`, `opportunity-journey`, `operations` tests |
| 22 | Bryntum | `allocation-scheduler`, `schedule-authority`, `allocation-model` tests, source untouched |
| 23 | Square attribution | `square-live`, `performance-incentive` tests, source untouched |
| 24–25 | Incentive, approval | `performance-incentive`, `work-payables`, `incentive-payout` tests, source untouched |
| 26 | PayPal payout | `work-payouts`, `paypal-final` tests, source untouched |
| 27 | £96 + £25 = £121 | `paypal-final.test.ts`, unchanged, and `workload-opportunity.test.ts` from a shift created through an opportunity |
| 28 | AI interpretation only | `workload-opportunity.test.ts`, `ai-staffing`, `ai-staffing-contract` tests |

Adversarial cases include forged evidence fields in the form, a malformed window, another tenant's scope naming this location, database inserts bypassing the service, and attempts to update or delete frozen evidence and policy versions.

## 13. UI evidence

Local production build from a copy of the source with no `.env` files, a throwaway PostgreSQL database, no provider keys, and history loaded through the real CLI: 45,126 rows, 31 Aug to 1 Nov 2026, `uk-hospitality-v1`. A rerun with `--through 2026-11-05` was refused with nothing written. Headless Chrome on the real clock.

35 walkthrough steps across 1280, 1024, 768 and 390 px had no page overflow, no console errors and no broken navigation. Key screens were also checked by eye. An early run was discarded because every page had redirected to sign-in, and the walker now fails that case.

Screenshots are in `docs/evidence/fs-workload-intelligence-001/`.

| Screenshot | Shows |
|---|---|
| `01`, `02` | Five venues; history labelled synthetic |
| `03`, `04`, `05`, `06` | **True reference state:** demand and cover known, "Configuration required", never zero |
| `07` | A capacity of 0 refused through the real form |
| `10`, `11`, `12`, `13` | **Test fixture**: commercial, operational and staffing layers; service-period drill-down; configuration; manager view |
| `14`, `15` | **Test fixture**: Fill Shifts context, frozen reason, unchanged worker eligibility, shift adjusted by the Manager |
| `16` | **Test fixture**: Bryntum schedule still renders |
| `w1024-*`, `w768-*`, `w390-*` | Narrower layouts |

**Every "fixture" screenshot uses 12 transactions per staff hour and a minimum of 1, on the throwaway database.** They carry a red banner saying so. They aren't reference-company policy.

## 14. Golden Path status

| Step | Status |
|---|---|
| 1–3. Synthetic history across five venues; commercial and operational baseline; service-period drill-down | **VERIFIED locally.** The casual requirement needs the Owner's two values |
| 4–7. Contextual signal, AI scenario, Manager acceptance, recalculation | **NOT IMPLEMENTED in this package** |
| 8. Baseline opportunity into Fill Shifts | **VERIFIED locally** with fixture values |
| 9. Location, availability and conflict filtering | **VERIFIED**, unchanged |
| 10–11. Transparent terms, acceptance, allocation, Bryntum | **VERIFIED** by regression tests, unchanged |
| 12. Square Sandbox attribution | Earlier genuine evidence stands (`SQUARE_LIVE_EVIDENCE.md`); regression tests pass; no new provider call |
| 13. £96 + £25 = £121 | **VERIFIED** by regression tests, unchanged |
| 14–15. Approval and PayPal payout | Earlier genuine Sandbox evidence stands (`PAYPAL_FINAL_EVIDENCE.md`); no new payout |

The hospitality chain has not been run end to end against genuine providers in one sitting.

## 15. Limitations

- **Hosted would change visibly if this were deployed as is.** It needs migration 0022. An outlet holding a retail reference history refuses hospitality data by design, so it needs a fresh organisation or a separate decision. Until a policy, trading hours and regular cover exist, staffing shows "Configuration required".
- **The old 14:00–20:00 Golden Path gap no longer arises by itself.** Windows now come from the data and policy. A Manager can still create that shift by hand from an overlapping opportunity. The economics are unaffected.
- **Bank holidays and one-off closures aren't in weekly trading hours.** Trading hours are a repeating week.
- **The daily sales forecast doesn't know a day is stated closed.** Staffing shows it as closed with no requirement, but the commercial table may still show a value. All five reference venues trade every week.
- **No trading past midnight yet.** A late venue would need a later change.
- **Whole-number capacity.** Half units aren't accepted.
- **Period ranges are summed.** Range widths across several hours overstate spread. They aren't calibrated confidence intervals.
- **The configuration form is typed text**, such as `07:00-12:00 x3`. It's validated, but it isn't a visual editor.
- **Evidence ages.** From three days old, AI input is flagged stale. The calendar runs to 31 Jan 2027.
- **A legacy single-day estimate remains:** `staffedForecast` and `getManagerForecast`, with `minimumWorkers: 2` in USD. No page reaches it; only `pnpm smoke:manager` and tests do. It wasn't removed because it's outside this package.
- **No genuine provider run:** no OpenAI, Square or PayPal call was made.

## 16. Claims

**Safe now, once a business has configured its policy:**

> FairShift forecasts each location's commercial sales and expected transaction workload across the trading day. It compares that workload with the business's own capacity policy and regular coverage to identify when additional casual work is likely to be needed.

**Prohibited now:** contextual AI changes demand; weather-aware, event-aware or private-booking-aware forecasting; AI forecasts demand; AI worker matching; measured weather or event effects; machine-learned staffing accuracy; reservation integration; cover forecasting. Also don't describe synthetic reference transactions as Square transactions.

**Future, only after FS-DEMAND-CONTEXT-001 is implemented and verified:**

> FairShift combines historical commerce demand with sourced operational context. Its AI proposes a bounded, cited adjustment that a manager can accept or reject; deterministic rules then convert the accepted demand into casual work, and approved earnings flow through to PayPal.

## 17. Quality gates

Run on one frozen tree: a checksum of `src`, `tests`, `scripts` and `drizzle` matched before and after the two test runs. Only documentation changed afterwards.

| Check | Result |
|---|---|
| Full test suite, run 1 | 64 files, 713 tests passed, 501.1 s |
| Full test suite, run 2 | 64 files, 713 tests passed, 501.0 s |
| `pnpm typecheck` | Exit 0 |
| `pnpm lint` | Exit 0, no findings |
| `pnpm smoke:manager` | PASS |
| Production build | Succeeded from the copy with no `.env` files, with `DATABASE_URL` at a dead local port and no provider keys |
| Browser walkthrough | 35 steps, 0 problems (section 13). The final build of the same source |
| Migration 0022 | Applied on scratch PostgreSQL 15 and all test databases |

## 18. Safety

Nothing was deployed or pushed, and main wasn't merged. Hosted data wasn't touched. No OpenAI, Square, PayPal or email provider was called.

One slip: during UI work, a `pnpm build` ran once in the repository directory, where `.env.local` exists, with `DATABASE_URL` pointed at the stopped scratch database. It wasn't part of the gates. Next.js builds don't call the providers, and the affected pages are dynamic, but no network capture was running, so that absence is **INFERENCE**. The output is the git-ignored `.next`. The recorded build gate ran from the copy with no `.env` files.
