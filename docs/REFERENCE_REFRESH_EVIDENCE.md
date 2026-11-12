Working note from the build. It may describe an earlier state. The README and docs/SUBMISSION_EVIDENCE.md describe the submitted build.

# Reference Refresh Evidence (FS-REFERENCE-REFRESH-001)

> **Superseded as the active reference company on 2 November 2026.** The Owner moved the reference vertical to hospitality. See `docs/WORKLOAD_INTELLIGENCE_EVIDENCE.md`. This record describes the retail work as it was and is otherwise unchanged. Its staffing method and £100 per labour hour assumption are no longer in the active path. `uk-specialty-retail-v2` stays reproducible in `src/server/reference/uk-retail.ts` and can't be loaded.

**Status: complete locally, and not loaded anywhere hosted.** The refreshed five-location reference history drives Golden Path steps 1 to 4 on a throwaway database. Status terms follow `AGENTS.md` §8. Reference data is **SIMULATED**: labelled synthetic input, never provider sales.

| Item | Value |
|---|---|
| Branch | `fs-square-live-001` |
| Starting and final HEAD | `e849eba5f076405f15efac75b38ac0cd39db91e1` |
| Tree state | Uncommitted. Nothing committed or pushed |
| Validated | 1 Nov 2026, about 22:00 to 22:20 UTC, on the real clock |

## 1. The problem

`uk-specialty-retail-v1` ended on 28 December 2025, 309 days before the planning week. Its latest 56 days were peak Christmas trading, which the forecast mapped onto ordinary weeks. Its rotas were tuned to those sales, so an autumn window would have shown almost no casual gaps.

## 2. What changed

| File | Change |
|---|---|
| `src/server/reference/uk-retail.ts` | Dataset `uk-specialty-retail-v2`: new calendar, store behaviour and rotas |
| `src/server/reference/provision.ts` | Takes a clock. Defaults to the latest completed day, and refuses later dates |
| `scripts/load-reference-history.ts` | Usage text only |
| `tests/unit/reference-history.test.ts`, `tests/integration/reference-refresh.test.ts` | Rewritten and new |
| Five other integration test files | Moved to the new calendar. `staffing.test.ts` also has reworded gap and zero-gap assertions, because a fully covered store is now a real state |

Not changed: forecast method, source rule, staffing calculation, schema and migrations, UI, AI contract, Square, PayPal, Bryntum.

## 3. Dates

| Item | Value |
|---|---|
| Forecast period | Next seven local days from tomorrow. It rolls with the clock. Validated week: Mon 2 to Sun 8 Nov 2026 |
| Dataset calendar | Mon 4 Nov 2024 to Sun 1 Nov 2026: 104 complete weeks |
| Loaded for validation | To Sat 31 Oct 2026, the latest completed day at that time: 131,156 rows |
| Forecast lookback | 56 days ending at the data-through date, from `forecast.ts` |
| Holdout start | 10 Aug 2026 (out-of-sample evaluation is still not implemented) |

- **History rules, verified in code:** a provider source needs 28 days and three of every weekday in 56 days. Reference history has **no minimum depth**: thin history forecasts with `LOW` support, and no history gives no forecast. The full load has at least three of every weekday at every store.
- **Calendar:** factual England and Wales bank holidays for the period, plus large-shop closures on Christmas Day and Easter Sunday. No bank holiday falls in the lookback or the validated week. Black Friday and Christmas factors apply only in earlier history. Weather and external events aren't modelled.

## 4. Generation

A deterministic generator: a SHA-256 seed of version, store, date and purpose feeds a mulberry32 stream, so the same date always gives the same rows. Daily demand is base × weekday × blended season × momentum × events × growth × noise. Receipts sum exactly to each day.

Rows go through the existing canonical boundary with `REFERENCE` provenance, deterministic references and a database constraint against provider claims. No worker attribution is generated.

Thursday to Saturday now trade until 20:00, so a 14:00–20:00 shift falls inside trading hours. Monthly season values blend between mid-months, so no month starts with a jump.

## 5. Five locations and labour assumptions

The labour policy is one organisation-level assumption: £100 of forecast sales per labour hour, source `REFERENCE`. It's an assumption of this fictional company, not a benchmark. Planning rounds up to 15 minutes, and indicative shifts divide the gap by 8 hours. Rotas are hand-set inputs. Store names below are validation fixture names; the loader maps codes to whichever outlets it's given.

| Code | Story | Volatility | Momentum | Regular hours Mon–Sun |
|---|---|---|---|---|
| UK01 Leeds | Steady; late-week cover runs slightly short | 5% | +2% | 32, 32, 32, 32, 34, 48, 32 |
| UK02 Manchester | Growing fast; rota behind from Wednesday | 6% | +20% | 44, 44, 40, 44, 48, 56, 44 |
| UK03 Birmingham | Softening; fully covered. Closed for stocktake on 6 Oct 2026 | 5% | −10% | 40, 40, 40, 40, 48, 56, 40 |
| UK04 Brighton | Quiet weekdays, volatile visitor weekends, thin Sunday | 11% | 0% | 24, 24, 24, 24, 28, 36, 24 |
| UK05 London Stratford | Largest; short only at the Friday and Saturday peak. Short trading day on 23 Sep 2026 | 8% | +5% | 64, 64, 64, 72, 72, 88, 72 |

Validated result, data through 31 October (forecast sales, and casual gap where there is one):

| Location | Mon | Tue | Wed | Thu | Fri | Sat | Sun | Week forecast | Week gap |
|---|---|---|---|---|---|---|---|---|---|
| Birmingham | £3,395 | £3,331 | £3,487 | £3,619 | £3,919 | £4,990 | £3,275 | £26,017 | 0 h |
| Brighton | £1,749 | £1,849 | £1,887 | £2,049 | £2,569 | £3,943 · 3.5 h | £3,029 · 6.5 h | £17,076 | 10 h |
| Leeds | £2,869 | £2,928 | £3,119 | £3,436 · 2.5 h | £3,939 · 5.5 h | £5,273 · 4.75 h | £3,090 | £24,655 | 12.75 h |
| Stratford | £5,644 | £5,935 | £6,001 | £6,802 | £7,503 · 3.25 h | £9,615 · 8.25 h | £6,715 | £48,215 | 11.5 h |
| Manchester | £4,115 | £4,096 | £4,809 · 8.25 h | £5,096 · 7 h | £5,948 · 11.5 h | £7,253 · 16.75 h | £4,062 | £35,379 | 43.5 h |

Company total: £151,342 forecast and a 77.75 h gap. **Golden Path gap:** Leeds, Fri 6 Nov, 5.5 h, which one 14:00–20:00 shift closes. The shift created through the UI showed £96 base, £200 target, £25 bonus, up to £121.

## 6. Provenance

| | REFERENCE history | Square Sandbox evidence |
|---|---|---|
| Role | Planning input | Worker performance |
| Origin | Generated by this repository | Genuine Sandbox payments (`SQUARE_LIVE_EVIDENCE.md`) |
| In this package | Loaded locally | Not exercised against Square; a local test row checks the separation |

A few Square payments can't replace reference history (rejected for too few days), and the two are never summed.

## 7. Negative tests

All executed and passing, in `tests/integration/reference-refresh.test.ts` unless noted.

| Case | Result |
|---|---|
| Future date, or today before it has finished | Loader refuses and writes nothing. Real CLI refused `--through 2026-11-05` |
| Past the dataset's end | Default stops at the last day; an explicit later date is refused |
| Future-dated observation | `FUTURE_DATED` |
| Negative or fractional amount | `INVALID_OBSERVATION`; the database also refuses a negative reference row |
| Malformed date, or an invented extra field | `INVALID_OBSERVATION` |
| Invalid calendar date | Rejected (`tests/unit/reference-history.test.ts`) |
| Wrong tenant, or another organisation's outlet | `UNKNOWN_LOCATION`; loader refusals in `reference-history.test.ts` |
| Unknown currency, or mixing currencies | `UNSUPPORTED_CURRENCY`, `CURRENCY_MISMATCH` |
| Rerun | Inserts 0. Real CLI: 0 of 131,156 |
| Same identity with different facts | `CONFLICTING_DUPLICATE`; the whole load rolls back |
| Earlier dataset version in an outlet | Refused, with no rows added |
| Thin history | `LOW` support |
| No history | No forecast and no gap, never zero |
| No labour policy, or one in another currency | `NO_LABOUR_POLICY`, `LABOUR_POLICY_CURRENCY_MISMATCH`, with no gap |
| Absent versus zero coverage | Absent: `REGULAR_COVERAGE_NOT_SET`, no gap. Zero: the gap equals required labour |
| Square provenance claimed through the import path | `UNSUPPORTED_SOURCE` |
| Square alongside reference | Forecast unchanged; rows stay separate; a reference rerun doesn't alter them |

## 8. UI validation

Local production build, a throwaway PostgreSQL database, no provider credentials, and history loaded through the real CLI (about 13 s). Headless Chrome, viewed by eye for the screenshots below.

| Screenshot (`docs/evidence/fs-reference-refresh-001/`) | What it demonstrates |
|---|---|
| `01-owner-overview.png` | Five-location pulse: £162,177 latest week, £151,342 forecast, 77.75 h gap, ranked shortfalls, labelled as not Square or PayPal sales |
| `02-owner-sales-recent-28-days.png` | All five locations, recent dates, different totals, "Reference sales history · synthetic". Birmingham shows 27 days because of its stocktake |
| `03-owner-forecast.png` | Daily forecast heatmap, with covered days, modest gaps and Manchester's clear gap, under a notice that this is synthetic evidence |
| `04-owner-location-drilldown-leeds.png` | Demand, labour, coverage and gap for Leeds, day by day, with commerce evidence |
| `05-manager-forecast-staffing.png` | The same Leeds figures for the manager, with no location selector |
| `06-fill-shifts-carried-gap.png` | The real Fri 6 Nov link carries the date and gap chain into Fill Shifts |
| `07-fill-shifts-gap-kept-after-shift-created.png` | Regression check: with a shift on that day, the gap figures remain |
| `08-owner-sales-latest-days.png` | Manchester's latest days, with correct weekdays and credible variation |
| `09-owner-forecast-390.png`, `10-manager-plan-390.png`, `11-fill-shifts-390.png` | Phone layouts |

The six surfaces were also loaded at 1024, 768 and 390 px: no page overflow and no console errors on any screen.

**AI:** no provider call was made, so the screens show "not configured". A real AI explanation of this dataset is **NOT VERIFIED**. A test confirms the AI input carries the synthetic flag, ranks Manchester's Saturday first and matches the calculated gap. `tests/integration/ai-staffing.test.ts` passes on this dataset with a stubbed model.

## 9. Quality gates

Run on one frozen tree (checksums matched before and after). Only this document and a pointer in `REFERENCE_COMMERCE_FORECAST_EVIDENCE.md` changed afterwards.

| Check | Result |
|---|---|
| Full test suite, run 1 | 62 files, 676 tests passed, 443.8 s |
| Full test suite, run 2 | 62 files, 676 tests passed, 444.0 s |
| `pnpm typecheck` | Exit 0 |
| `pnpm lint` | Exit 0, no findings |
| `pnpm smoke:manager` | PASS |
| `pnpm build` | Exit 0. Database URL pointed at a dead local port; provider keys blanked |
| Migrations | Not touched |

An earlier gate run was stopped and discarded when its scratch directory was retired. These results come from a complete rerun. The UI walkthrough used an earlier build of the same application source; only one test was added after it.

## 10. Limitations

- **Hosted can change the story.** The loader keeps an existing labour policy and any `CONFIGURED` rota, so a demo business with its own settings won't show these gaps. The manager's location must be mapped to UK01 for the Leeds gap.
- **Ageing.** The forecast's figures don't move with the clock, but evidence ages. From three days old, AI input is flagged `HISTORICAL_EVIDENCE_STALE`, which is correct behaviour. The calendar ends on 1 Nov 2026, so going later needs a further extension.
- **Loading after 1 November adds that Sunday.** Simulated, not validated in the UI: Sunday forecasts shift slightly, and Leeds would show a 0.5 h Sunday gap.
- **Black Friday isn't modelled for planning.** A planning week containing 27 Nov 2026 won't reflect it.
- **The model doesn't project trends.** Manchester's forecast (£35,379) sits below its latest week (£39,328) despite its growth.
- **Weekly hours can look contradictory.** The company shows 1,517.25 h required and 1,546 h covered, yet a 77.75 h gap, because surplus on one day doesn't offset a shortfall on another. This is correct, but may need explaining.
- **Fill Shifts defaults to 09:00–17:00.** The manager must enter 14:00–20:00. Not changed here.
- **Sales has no per-location chart.** Differences read from tables and the Forecast heatmap.
- **Daily forecast only.** Nothing here supports hourly forecasting or accuracy claims.
- **Not exercised:** worker acceptance, allocation, Square, PayPal, or a real OpenAI response in this package.

## 11. Hosted safety

Hosted was untouched. No reference load, migration, push or deployment, and no change to Render, DNS, `APP_BASE_URL`, email configuration or `FAIRSHIFT_PUBLIC_DEMO`. No Square, PayPal, OpenAI or email provider was called. The migration, loader, seed and local server ran from a copy of the source with no `.env` files and an explicit throwaway database URL.
